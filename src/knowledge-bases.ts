import {
  ensureAllowed,
  hasOption,
  integerOption,
  option,
  options,
  type ParsedArguments,
} from "./args.js";
import type { CredentialStore } from "./credentials.js";
import {
  CliError,
  INGESTION_FAILED_EXIT_CODE,
  WAIT_TIMED_OUT_EXIT_CODE,
} from "./errors.js";
import {
  ManagementClient,
  UUID_PATTERN,
  type CreateKnowledgeBaseBody,
  type CreatedKnowledgeBase,
} from "./management.js";
import { managementAuthorizer, type ManagementScope } from "./oauth.js";
import {
  describeIngestion,
  formatBytes,
  printable,
  progressWriter,
  writeJsonSuccess,
  type OutputStreams,
  type ProgressEvent,
} from "./output.js";
import { pendingOperation, pendingRetry, type PendingRetry } from "./resume.js";
import type { IngestionJob, KnowledgeBase, Upload } from "./types.js";
import {
  finishUpload,
  inspectLocalFile,
  resumeFingerprint,
  type LocalFile,
} from "./uploads.js";

export const KNOWLEDGE_BASE_COMMANDS = ["create", "list", "status", "retry", "recrawl"];

export type ManagementContext = {
  /** Arguments after the subcommand. */
  arguments_: ParsedArguments;
  /** The subcommand: one of KNOWLEDGE_BASE_COMMANDS. */
  subcommand: string;
  origin: string;
  environment: NodeJS.ProcessEnv;
  json: boolean;
  output: OutputStreams;
  store: CredentialStore;
  fetchImpl?: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
};

const READ: ManagementScope = "knowledge_bases:read";
const WRITE: ManagementScope = "knowledge_bases:write";
const DEFAULT_WAIT_SECONDS = 30 * 60;
const DEFAULT_PARALLEL = 4;
const MAX_PARALLEL = 8;
// The server hands a stalled upload initialization to a new request after two
// minutes, so waiting a little longer always ends in an open upload.
const INITIALIZATION_POLLS = 180;
const MAX_NAME_LENGTH = 120;
const MAX_URL_LENGTH = 2_048;
const MAX_PATH_PATTERNS = 20;
const MAX_PATH_PATTERN_LENGTH = 256;
const UPLOAD_OPTIONS = ["file", "zip", "parallel"];
const WEB_OPTIONS = [
  "allow-documents",
  "exclude-path",
  "include-path",
  "include-subdomains",
  "max-depth",
  "max-pages",
  "mode",
  "query-policy",
  "render-mode",
];
const REQUEST_OPTIONS = ["retries", "timeout"];
const TARGET_OPTIONS = ["kb", "knowledge-base"];
/** Next actions the server waits on the client for; polling cannot change them. */
const CLIENT_ACTIONS = new Set(["upload_parts", "complete_upload"]);

type WebSource = Record<string, unknown> & { type: "web"; url: string };
type VideoSource = { type: "video_url"; url: string };

type CreationPlan = {
  name?: string;
  path?: string;
  source?: WebSource | VideoSource;
};

type WaitSettings = { enabled: boolean; timeoutMs: number };

type WaitOutcome = {
  job: IngestionJob;
  /** Why waiting stopped: the job finished, needs the client, or time ran out. */
  settled: "terminal" | "client_action" | "timed_out";
  waitedForMs: number;
};

function usage(code: string, message: string): CliError {
  return new CliError("usage", code, message);
}

function choice(name: string, value: string, allowed: readonly string[]): string {
  if (!allowed.includes(value)) {
    throw usage("invalid_option_value", `--${name} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function httpUrl(value: string, name: string): string {
  const trimmed = value.trim();
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    // Reported below.
  }
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    trimmed.length > MAX_URL_LENGTH
  ) {
    throw usage(
      "url_invalid",
      `--${name} must be an absolute http or https URL of at most ${MAX_URL_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function pathPatterns(arguments_: ParsedArguments, name: string): string[] {
  const values = options(arguments_, name).map((value) => value.trim());
  if (values.length > MAX_PATH_PATTERNS) {
    throw usage(
      "path_patterns_too_many",
      `--${name} may be repeated at most ${MAX_PATH_PATTERNS} times.`,
    );
  }
  for (const value of values) {
    if (
      !value.startsWith("/") ||
      value.length > MAX_PATH_PATTERN_LENGTH ||
      /[?#\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw usage(
        "path_pattern_invalid",
        `--${name} values must start with / and contain no query or fragment, in at most ${MAX_PATH_PATTERN_LENGTH} characters.`,
      );
    }
  }
  return values;
}

/** Crawl settings, sending only what was given so the server's defaults apply. */
function webSource(arguments_: ParsedArguments, url: string): WebSource {
  const source: WebSource = { type: "web", url: httpUrl(url, "url") };
  const mode = option(arguments_, "mode");
  if (mode !== undefined) source.mode = choice("mode", mode, ["site", "single_url"]);
  const includePaths = pathPatterns(arguments_, "include-path");
  if (includePaths.length > 0) source.include_paths = includePaths;
  const excludePaths = pathPatterns(arguments_, "exclude-path");
  if (excludePaths.length > 0) source.exclude_paths = excludePaths;
  const queryPolicy = option(arguments_, "query-policy");
  if (queryPolicy !== undefined) {
    source.query_policy = choice("query-policy", queryPolicy, [
      "drop_tracking",
      "preserve",
      "strip",
    ]);
  }
  const renderMode = option(arguments_, "render-mode");
  if (renderMode !== undefined) {
    source.render_mode = choice("render-mode", renderMode, ["auto", "always", "never"]);
  }
  if (hasOption(arguments_, "include-subdomains")) source.include_subdomains = true;
  if (hasOption(arguments_, "allow-documents")) source.allow_documents = true;
  if (hasOption(arguments_, "max-pages")) {
    source.max_pages = integerOption(arguments_, "max-pages", 100, { min: 1, max: 1_000 });
  }
  if (hasOption(arguments_, "max-depth")) {
    source.max_depth = integerOption(arguments_, "max-depth", 3, { min: 0, max: 10 });
  }
  return source;
}

function creationPlan(arguments_: ParsedArguments): CreationPlan {
  const file = option(arguments_, "file");
  const zip = option(arguments_, "zip");
  const url = option(arguments_, "url");
  const videoUrl = option(arguments_, "video-url");
  const given = [file, zip, url, videoUrl].filter((value) => value !== undefined).length;
  if (given !== 1) {
    throw usage(
      given === 0 ? "source_required" : "source_conflict",
      "Provide exactly one source: --file, --zip, --url, or --video-url.",
    );
  }
  const misplaced =
    url === undefined ? WEB_OPTIONS.find((name) => hasOption(arguments_, name)) : undefined;
  if (misplaced) {
    throw usage("web_option_requires_url", `--${misplaced} applies only to --url.`);
  }
  if (hasOption(arguments_, "parallel") && file === undefined && zip === undefined) {
    throw usage("parallel_requires_file", "--parallel applies only to --file or --zip.");
  }
  if (zip !== undefined && !/\.zip$/iu.test(zip)) {
    throw usage("zip_required", "--zip expects a .zip archive. Use --file for other files.");
  }
  const rawName = option(arguments_, "name");
  const name = rawName?.trim();
  if (name !== undefined && (name.length === 0 || name.length > MAX_NAME_LENGTH)) {
    throw usage("name_invalid", `--name must contain 1 to ${MAX_NAME_LENGTH} characters.`);
  }
  const path = file ?? zip;
  if (path !== undefined) return { name, path };
  if (videoUrl !== undefined) {
    return { name, source: { type: "video_url", url: httpUrl(videoUrl, "video-url") } };
  }
  return { name, source: webSource(arguments_, url!) };
}

function waitSettings(arguments_: ParsedArguments, flag: "wait" | "watch"): WaitSettings {
  const enabled = hasOption(arguments_, flag);
  if (!enabled && hasOption(arguments_, "wait-timeout")) {
    throw usage("wait_timeout_requires_wait", `--wait-timeout requires --${flag}.`);
  }
  const seconds = integerOption(arguments_, "wait-timeout", DEFAULT_WAIT_SECONDS, {
    min: 1,
    max: 86_400,
  });
  return { enabled, timeoutMs: seconds * 1_000 };
}

function idempotencyKeyOption(arguments_: ParsedArguments): string | undefined {
  const value = option(arguments_, "idempotency-key");
  if (value !== undefined && !UUID_PATTERN.test(value)) {
    throw usage("uuid_invalid", "--idempotency-key must be a UUID.");
  }
  return value;
}

/** The knowledge base a command acts on: `<id>`, or --knowledge-base/--kb. */
function targetId(arguments_: ParsedArguments, command: string): string {
  const long = option(arguments_, "knowledge-base");
  const short = option(arguments_, "kb");
  if (arguments_.positionals.length > 1) {
    throw usage("unexpected_argument", `${command} accepts one knowledge-base ID.`);
  }
  const given = [arguments_.positionals[0], long, short].filter(
    (value) => value !== undefined,
  );
  if (given.length > 1) {
    throw usage(
      "knowledge_base_conflict",
      "Provide the knowledge-base ID once: as an argument, --knowledge-base, or --kb.",
    );
  }
  const value = given[0];
  if (!value) {
    throw usage(
      "knowledge_base_required",
      `Provide a knowledge-base ID: kb-drop ${command} <knowledge-base-id>.`,
    );
  }
  if (!UUID_PATTERN.test(value)) {
    throw usage("knowledge_base_invalid", "The knowledge-base ID must be a UUID.");
  }
  return value;
}

async function managementClient(
  context: ManagementContext,
  scopes: ManagementScope[],
): Promise<ManagementClient> {
  const { arguments_ } = context;
  const retry = {
    retries: integerOption(arguments_, "retries", 2, { min: 0, max: 5 }),
    timeoutMs: integerOption(arguments_, "timeout", 30_000, { min: 1_000, max: 120_000 }),
    fetchImpl: context.fetchImpl,
    sleep: context.sleep,
  };
  const authorize = managementAuthorizer(
    context.origin,
    { store: context.store, fetchImpl: context.fetchImpl, now: context.now },
    context.environment,
    scopes,
  );
  // A missing or unusable credential fails here, before any work starts.
  await authorize();
  return new ManagementClient(context.origin, authorize, retry);
}

function ingestionEvent(job: IngestionJob): ProgressEvent {
  return {
    stage: "ingestion",
    knowledge_base_id: job.knowledge_base_id,
    job_id: job.id,
    status: job.status,
    next_action: job.next_action,
    progress: job.progress,
  };
}

/**
 * Polls a job at the server's pace until it finishes, needs the client, or the
 * timeout passes. Outages shorter than the timeout are waited out.
 */
async function waitForJob(
  client: ManagementClient,
  initial: IngestionJob,
  context: ManagementContext,
  timeoutMs: number,
  report: (event: ProgressEvent) => void,
): Promise<WaitOutcome> {
  const started = context.now();
  const deadline = started + timeoutMs;
  let job = initial;
  let failure: CliError | null = null;
  for (;;) {
    const waitedForMs = context.now() - started;
    if (job.terminal) return { job, settled: "terminal", waitedForMs };
    if (CLIENT_ACTIONS.has(job.next_action)) {
      return { job, settled: "client_action", waitedForMs };
    }
    const remaining = deadline - context.now();
    if (remaining <= 0) {
      if (failure) throw failure;
      return { job, settled: "timed_out", waitedForMs };
    }
    // A refused poll says when to ask again; otherwise the job does.
    const intervalSeconds = Math.min(
      30,
      Math.max(1, failure?.details.retryAfterSeconds ?? job.poll_after_seconds ?? 5),
    );
    await context.sleep(Math.min(intervalSeconds * 1_000, remaining));
    // No poll starts after the deadline, and each one ends by it. This loop
    // asks again on its own schedule, so a poll makes a single attempt.
    const budget = deadline - context.now();
    if (budget <= 0) continue;
    const cutoff = AbortSignal.timeout(budget);
    try {
      job = await client.getIngestionJob(job.id, { signal: cutoff, retries: 0 });
      failure = null;
      report(ingestionEvent(job));
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        (error.kind !== "transient" && error.kind !== "network")
      ) {
        throw error;
      }
      // A poll the deadline cut short ends the wait; it is not an outage.
      if (!cutoff.aborted) failure = error;
    }
  }
}

function waitExitCode(outcome: WaitOutcome | null): number {
  if (!outcome) return 0;
  if (outcome.settled !== "terminal") return WAIT_TIMED_OUT_EXIT_CODE;
  return outcome.job.status === "ready" ? 0 : INGESTION_FAILED_EXIT_CODE;
}

function duration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 120) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function sourceLabel(knowledgeBase: KnowledgeBase): string {
  const { source } = knowledgeBase;
  if (source.type === "upload") {
    const size = Number(source.size_bytes);
    return `${printable(String(source.filename))}${Number.isFinite(size) ? ` (${formatBytes(size)})` : ""}`;
  }
  const url = typeof source.url === "string" ? printable(source.url) : source.type;
  return source.type === "web" && typeof source.mode === "string"
    ? `${url} (website, ${source.mode})`
    : url;
}

/** What the person at the terminal can do next, or null when nothing is needed. */
function nextStep(job: IngestionJob, id: string): string | null {
  switch (job.next_action) {
    case "upload_parts":
    case "complete_upload":
      return "The upload is incomplete. Run the same create command again to resume it.";
    case "wait":
      return `Follow progress with: kb-drop knowledge-bases status ${id} --watch`;
    case "retry":
      return `Retry with: kb-drop knowledge-bases retry ${id}`;
    case "create_new_knowledge_base":
      return "This source cannot be processed again. Create a new knowledge base.";
    case "contact_support":
      return "Contact support if this continues.";
    default:
      return job.queryable ? `Ask it with: kb-drop ask --kb ${id} "your question"` : null;
  }
}

function outcomeLine(job: IngestionJob, outcome: WaitOutcome | null): string {
  if (job.failure) {
    return `Failed while ${printable(job.failure.stage)}: ${printable(job.failure.message)}`;
  }
  if (outcome?.settled === "timed_out") {
    return `Still ${job.status} after waiting ${duration(outcome.waitedForMs)}.`;
  }
  return `${describeIngestion(job)}.`;
}

function writeHumanResult(
  output: OutputStreams,
  headline: string,
  knowledgeBase: KnowledgeBase,
  job: IngestionJob,
  outcome: WaitOutcome | null,
): void {
  const lines = [headline, outcomeLine(job, outcome)];
  const next = nextStep(job, knowledgeBase.id);
  if (next) lines.push(next);
  output.stdout.write(`${lines.join("\n")}\n`);
}

/** Fetches the knowledge base again; a write-only key keeps the earlier snapshot. */
async function refreshed(
  client: ManagementClient,
  knowledgeBase: KnowledgeBase,
): Promise<KnowledgeBase> {
  try {
    return await client.getKnowledgeBase(knowledgeBase.id);
  } catch {
    return knowledgeBase;
  }
}

/** Creates, or replays, waiting while another request opens the same upload. */
async function createKnowledgeBase(
  client: ManagementClient,
  body: CreateKnowledgeBaseBody,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CreatedKnowledgeBase> {
  for (let poll = 0; poll < INITIALIZATION_POLLS; poll += 1) {
    const created = await client.createKnowledgeBase(body);
    if (created.status !== 202) return created;
    await sleep(Math.min(10, created.retryAfterSeconds ?? 1) * 1_000);
  }
  throw new CliError(
    "transient",
    "upload_initializing",
    "The upload is still being prepared. Run the same command again shortly.",
    { recovery: "wait" },
  );
}

async function maybeWait(
  client: ManagementClient,
  job: IngestionJob,
  context: ManagementContext,
  wait: WaitSettings,
  report: (event: ProgressEvent) => void,
): Promise<WaitOutcome | null> {
  return wait.enabled
    ? waitForJob(client, job, context, wait.timeoutMs, report)
    : null;
}

async function create(context: ManagementContext): Promise<number> {
  const { arguments_, output } = context;
  const command = "knowledge-bases create";
  ensureAllowed(arguments_, command, [
    ...UPLOAD_OPTIONS,
    ...WEB_OPTIONS,
    ...REQUEST_OPTIONS,
    "idempotency-key",
    "name",
    "url",
    "video-url",
    "wait",
    "wait-timeout",
  ]);
  if (arguments_.positionals.length > 0) {
    throw usage("unexpected_argument", `${command} does not accept positional arguments.`);
  }
  const plan = creationPlan(arguments_);
  const wait = waitSettings(arguments_, "wait");
  const parallel = integerOption(arguments_, "parallel", DEFAULT_PARALLEL, {
    min: 1,
    max: MAX_PARALLEL,
  });
  const explicitKey = idempotencyKeyOption(arguments_);
  const file: LocalFile | null = plan.path ? await inspectLocalFile(plan.path) : null;
  const client = await managementClient(context, wait.enabled ? [WRITE, READ] : [WRITE]);
  const report = progressWriter(output, context.json, "knowledge-bases.create");

  let source: CreateKnowledgeBaseBody["source"];
  if (file) {
    report({ stage: "prepare", filename: file.filename, bytes_total: file.sizeBytes });
    source = {
      type: "upload",
      filename: file.filename,
      size_bytes: file.sizeBytes,
      fingerprint: await resumeFingerprint(file),
    };
  } else {
    source = plan.source!;
  }
  const request = plan.name === undefined ? { source } : { name: plan.name, source };
  const pending = explicitKey
    ? null
    : await pendingOperation({
        environment: context.environment,
        apiUrl: context.origin,
        request: { operation: "create", ...request },
        now: context.now(),
      });
  let idempotencyKey = explicitKey ?? pending!.idempotencyKey;

  let created: CreatedKnowledgeBase;
  try {
    created = await createKnowledgeBase(
      client,
      { idempotency_key: idempotencyKey, ...request },
      context.sleep,
    );
  } catch (error) {
    // The interrupted attempt's upload expired or failed; its knowledge base
    // stays failed, so start over under a new key.
    if (
      !pending?.resumed ||
      !(error instanceof CliError) ||
      error.code !== "upload_unavailable"
    ) {
      throw error;
    }
    idempotencyKey = await pending.restart();
    if (!context.json) {
      output.stderr.write("The interrupted upload expired; starting a new knowledge base.\n");
    }
    created = await createKnowledgeBase(
      client,
      { idempotency_key: idempotencyKey, ...request },
      context.sleep,
    );
  }

  let knowledgeBase = created.knowledge_base;
  let job = created.ingestion_job;
  let upload: Upload | null = created.upload;
  if (file) {
    if (!upload) {
      throw new CliError("output", "unexpected_response", "The kbDrop API did not open an upload.");
    }
    if (upload.status === "uploading" || upload.status === "completing") {
      const finished = await finishUpload(
        {
          client,
          file,
          parallel,
          fetchImpl: context.fetchImpl,
          sleep: context.sleep,
          onProgress: report,
          // Repeating the creation request returns the upload as it is now.
          reload: async () => {
            const replayed = await createKnowledgeBase(
              client,
              { idempotency_key: idempotencyKey, ...request },
              context.sleep,
            );
            if (!replayed.upload) {
              throw new CliError("output", "unexpected_response", "The kbDrop API did not return the upload.");
            }
            return replayed.upload;
          },
        },
        upload,
      );
      upload = finished.upload;
      job = finished.job;
    }
  }
  report(ingestionEvent(job));

  const outcome = await maybeWait(client, job, context, wait, report);
  if (outcome) job = outcome.job;
  knowledgeBase = outcome
    ? await client.getKnowledgeBase(knowledgeBase.id)
    : await refreshed(client, knowledgeBase);
  // A finished command forgets its key, so running it again creates another
  // knowledge base. An interrupted or timed-out one resumes instead.
  if (!outcome || outcome.settled === "terminal") await pending?.finish();

  // A replay continues an earlier run's knowledge base, unless it answered
  // this run's own retried request under a key it just made.
  const resumed = created.status === 200 && (pending?.resumed ?? true);
  if (context.json) {
    writeJsonSuccess(output, "knowledge-bases.create", {
      knowledge_base: knowledgeBase,
      ingestion_job: job,
      upload,
      resumed,
      idempotency_key: idempotencyKey,
    });
  } else {
    writeHumanResult(
      output,
      `${resumed ? "Resumed" : "Created"} knowledge base "${printable(knowledgeBase.name)}" (${knowledgeBase.id}).`,
      knowledgeBase,
      job,
      outcome,
    );
  }
  return waitExitCode(outcome);
}

async function status(context: ManagementContext): Promise<number> {
  const { arguments_, output } = context;
  const command = "knowledge-bases status";
  ensureAllowed(arguments_, command, [
    ...REQUEST_OPTIONS,
    ...TARGET_OPTIONS,
    "wait-timeout",
    "watch",
  ]);
  const id = targetId(arguments_, command);
  const watch = waitSettings(arguments_, "watch");
  const client = await managementClient(context, [READ]);
  const report = progressWriter(output, context.json, "knowledge-bases.status");
  let knowledgeBase = await client.getKnowledgeBase(id);
  let job = await client.getIngestionJob(knowledgeBase.latest_job.id);
  let outcome: WaitOutcome | null = null;
  if (watch.enabled) {
    report(ingestionEvent(job));
    outcome = await maybeWait(client, job, context, watch, report);
    if (outcome && outcome.job !== job) {
      job = outcome.job;
      knowledgeBase = await client.getKnowledgeBase(id);
    }
  }
  if (context.json) {
    writeJsonSuccess(output, "knowledge-bases.status", {
      knowledge_base: knowledgeBase,
      ingestion_job: job,
    });
  } else {
    const lines = [
      `${printable(knowledgeBase.name)} (${knowledgeBase.id})`,
      `Source:    ${sourceLabel(knowledgeBase)}`,
      `Status:    ${outcomeLine(job, outcome)}`,
      `Queryable: ${
        knowledgeBase.queryable && knowledgeBase.active_version !== null
          ? `yes (version ${knowledgeBase.active_version})`
          : "no"
      }`,
    ];
    const next = nextStep(job, knowledgeBase.id);
    if (next) lines.push(`Next:      ${next}`);
    output.stdout.write(`${lines.join("\n")}\n`);
  }
  return waitExitCode(outcome);
}

async function list(context: ManagementContext): Promise<number> {
  const { arguments_, output } = context;
  const command = "knowledge-bases list";
  ensureAllowed(arguments_, command, [...REQUEST_OPTIONS, "cursor", "limit"]);
  if (arguments_.positionals.length > 0) {
    throw usage("unexpected_argument", `${command} does not accept positional arguments.`);
  }
  const limit = integerOption(arguments_, "limit", 20, { min: 1, max: 100 });
  const cursor = option(arguments_, "cursor");
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > 200)) {
    throw usage("cursor_invalid", "--cursor must be the next_cursor from an earlier page.");
  }
  const client = await managementClient(context, [READ]);
  const page = await client.listKnowledgeBases({ limit, cursor });
  if (context.json) {
    writeJsonSuccess(output, "knowledge-bases.list", page);
    return 0;
  }
  if (page.data.length === 0) {
    output.stdout.write(cursor ? "No more knowledge bases.\n" : "No knowledge bases yet.\n");
    return 0;
  }
  const lines = page.data.map(
    (knowledgeBase) =>
      `${knowledgeBase.id}  ${knowledgeBase.status.padEnd(10)}  ${printable(knowledgeBase.name)}`,
  );
  if (page.has_more && page.next_cursor) {
    lines.push(`More: kb-drop knowledge-bases list --cursor ${page.next_cursor}`);
  }
  output.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** Explains locally why the latest job cannot be retried, in the server's terms. */
function notRetryable(job: IngestionJob): CliError {
  if (!job.terminal) {
    return new CliError(
      "transient",
      "ingestion_in_progress",
      "The latest ingestion job is still running.",
      { recovery: "wait" },
    );
  }
  if (job.status === "ready") {
    return new CliError(
      "request",
      "ingestion_job_succeeded",
      "The latest ingestion job succeeded, so there is nothing to retry.",
    );
  }
  if (job.next_action === "contact_support") {
    return new CliError(
      "request",
      "ingestion_needs_support",
      "This failure cannot be retried.",
      { recovery: "contact_support" },
    );
  }
  return new CliError(
    "request",
    "ingestion_not_retryable",
    "This source cannot be processed again.",
    { recovery: "create_new_knowledge_base" },
  );
}

/**
 * Replays the retry an interrupted run sent. Returns null, forgetting it, when
 * a newer job has replaced that one, so the latest job is retried instead.
 */
async function replayRetry(
  client: ManagementClient,
  pending: PendingRetry,
): Promise<{ replayed: boolean; job: IngestionJob } | null> {
  const { jobId, attempt } = pending.target!;
  try {
    return await client.retryIngestionJob(jobId, attempt);
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "ingestion_job_superseded") throw error;
    await pending.finish();
    return null;
  }
}

async function retry(context: ManagementContext): Promise<number> {
  const { arguments_, output } = context;
  const command = "knowledge-bases retry";
  ensureAllowed(arguments_, command, [
    ...REQUEST_OPTIONS,
    ...TARGET_OPTIONS,
    "wait",
    "wait-timeout",
  ]);
  const id = targetId(arguments_, command);
  const wait = waitSettings(arguments_, "wait");
  const client = await managementClient(context, [READ, WRITE]);
  const report = progressWriter(output, context.json, "knowledge-bases.retry");
  let knowledgeBase = await client.getKnowledgeBase(id);
  const pending = await pendingRetry({
    environment: context.environment,
    apiUrl: context.origin,
    knowledgeBaseId: id.toLowerCase(),
    now: context.now(),
  });
  // An interrupted run follows the attempt it retried, even once that attempt
  // has failed too, rather than retrying whichever attempt is now the latest.
  let retried = pending.target ? await replayRetry(client, pending) : null;
  if (!retried) {
    const failed = await client.getIngestionJob(knowledgeBase.latest_job.id);
    if (failed.next_action !== "retry") throw notRetryable(failed);
    // Naming the failed attempt makes a repeated retry a replay, not a second
    // run. It is saved first, so a rerun after a lost response replays it too.
    await pending.save({ jobId: failed.id, attempt: failed.attempt });
    retried = await client.retryIngestionJob(failed.id, failed.attempt);
  }
  let { job } = retried;
  report(ingestionEvent(job));
  const outcome = await maybeWait(client, job, context, wait, report);
  if (outcome) job = outcome.job;
  knowledgeBase = await client.getKnowledgeBase(id);
  // Once this can report how the attempt ended, running it again retries anew.
  if (!outcome || outcome.settled === "terminal") await pending.finish();
  if (context.json) {
    writeJsonSuccess(output, "knowledge-bases.retry", {
      knowledge_base: knowledgeBase,
      ingestion_job: job,
      resumed: retried.replayed,
    });
  } else {
    writeHumanResult(
      output,
      `${retried.replayed ? "Resumed retrying" : "Retrying"} "${printable(knowledgeBase.name)}" (${knowledgeBase.id}), attempt ${job.attempt}.`,
      knowledgeBase,
      job,
      outcome,
    );
  }
  return waitExitCode(outcome);
}

async function recrawl(context: ManagementContext): Promise<number> {
  const { arguments_, output } = context;
  const command = "knowledge-bases recrawl";
  ensureAllowed(arguments_, command, [
    ...REQUEST_OPTIONS,
    ...TARGET_OPTIONS,
    "idempotency-key",
    "wait",
    "wait-timeout",
  ]);
  const id = targetId(arguments_, command);
  const wait = waitSettings(arguments_, "wait");
  const explicitKey = idempotencyKeyOption(arguments_);
  const client = await managementClient(context, wait.enabled ? [WRITE, READ] : [WRITE]);
  const report = progressWriter(output, context.json, "knowledge-bases.recrawl");
  const pending = explicitKey
    ? null
    : await pendingOperation({
        environment: context.environment,
        apiUrl: context.origin,
        request: { operation: "recrawl", knowledge_base_id: id.toLowerCase() },
        now: context.now(),
      });
  const idempotencyKey = explicitKey ?? pending!.idempotencyKey;
  const started = await client.startCrawl(id, idempotencyKey);
  let knowledgeBase = started.knowledge_base;
  let job = started.ingestion_job;
  report(ingestionEvent(job));
  const outcome = await maybeWait(client, job, context, wait, report);
  if (outcome) {
    job = outcome.job;
    knowledgeBase = await client.getKnowledgeBase(id);
  }
  if (!outcome || outcome.settled === "terminal") await pending?.finish();
  if (context.json) {
    writeJsonSuccess(output, "knowledge-bases.recrawl", {
      knowledge_base: knowledgeBase,
      ingestion_job: job,
      resumed: started.replayed,
      idempotency_key: idempotencyKey,
    });
  } else {
    writeHumanResult(
      output,
      `${started.replayed ? "Resumed crawl" : "Crawling"} "${printable(knowledgeBase.name)}" (${knowledgeBase.id}) again as version ${job.version}.`,
      knowledgeBase,
      job,
      outcome,
    );
  }
  return waitExitCode(outcome);
}

export async function runKnowledgeBaseCommand(context: ManagementContext): Promise<number> {
  switch (context.subcommand) {
    case "create":
      return create(context);
    case "status":
      return status(context);
    case "list":
      return list(context);
    case "retry":
      return retry(context);
    case "recrawl":
      return recrawl(context);
    default:
      throw usage(
        "knowledge_base_command_required",
        `Use \`kb-drop knowledge-bases ${KNOWLEDGE_BASE_COMMANDS.join("|")}\`.`,
      );
  }
}
