import type { Writable } from "node:stream";
import { asCliError, EXIT_CODES } from "./errors.js";
import type { AskCompletion, IngestionJob, SearchResponse } from "./types.js";
import type { UploadProgress } from "./uploads.js";

export const CLI_SCHEMA_VERSION = "1";

export type OutputStreams = {
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
};

function line(stream: Pick<Writable, "write">, value = ""): void {
  stream.write(`${value}\n`);
}

export function writeJsonSuccess(
  streams: OutputStreams,
  command: string,
  data: unknown,
): void {
  line(
    streams.stdout,
    JSON.stringify({
      schema_version: CLI_SCHEMA_VERSION,
      ok: true,
      command,
      data,
    }),
  );
}

// What each management API `recovery` value asks of the person at the terminal.
const RECOVERY_HINTS: Record<string, string> = {
  ask_account_owner: "The account needs more quota or a plan change.",
  authenticate: "Check the credential, or log in again.",
  check_identifier: "Check the ID; resources in other accounts are not visible.",
  contact_support: "Contact support and quote the request ID.",
  create_new_knowledge_base: "Start over by creating a new knowledge base.",
  fix_request: "Correct the options and try again.",
  request_scope: "Use a credential with the required permission.",
  retry_later: "Try again later.",
  upload_missing_parts: "Run the same command again to upload the missing parts.",
  use_management_credential:
    "Set KB_DROP_MANAGEMENT_KEY or run `kb-drop auth login --manage`.",
  use_new_idempotency_key: "Use a new idempotency key for a different request.",
  wait: "Wait a moment, then run the command again.",
};

export function writeError(
  streams: OutputStreams,
  error: unknown,
  json: boolean,
): number {
  const failure = asCliError(error);
  const payload = {
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details.status ? { status: failure.details.status } : {}),
      ...(failure.details.retryAfterSeconds !== undefined
        ? { retry_after_seconds: failure.details.retryAfterSeconds }
        : {}),
      ...(failure.details.requestId
        ? { request_id: failure.details.requestId }
        : {}),
      ...(failure.details.recovery ? { recovery: failure.details.recovery } : {}),
    },
  };
  const hint = failure.details.recovery ? RECOVERY_HINTS[failure.details.recovery] : undefined;
  line(
    streams.stderr,
    json
      ? JSON.stringify(payload)
      : `kb-drop: ${failure.message} (${failure.code})${hint ? ` ${hint}` : ""}`,
  );
  return EXIT_CODES[failure.kind];
}

/** "Handbook · " when an interface answered, naming the source's knowledge base. */
function knowledgeBasePrefix(label: { name: string } | undefined): string {
  return label?.name ? `${printable(label.name, 80)} · ` : "";
}

export function writeHumanAnswer(
  streams: OutputStreams,
  completion: AskCompletion,
  alreadyStreamed = false,
): void {
  if (!alreadyStreamed) {
    if (completion.output) {
      line(streams.stdout, JSON.stringify(completion.output.value, null, 2));
    } else {
      line(streams.stdout, completion.answer ?? "");
    }
  } else {
    line(streams.stdout);
  }
  if (completion.citations.length > 0) {
    line(streams.stdout);
    line(streams.stdout, "Sources:");
    for (const citation of completion.citations) {
      const location = citation.locator_text
        ? ` — ${citation.locator_text}`
        : "";
      const link = citation.source_url ?? citation.deep_link;
      line(
        streams.stdout,
        `[${citation.id}] ${knowledgeBasePrefix(citation.knowledge_base)}${citation.display_title}${location}${link ? ` — ${link}` : ""}`,
      );
    }
  }
}

export function writeHumanSearch(
  streams: OutputStreams,
  response: SearchResponse,
): void {
  if (response.results.length === 0) {
    line(streams.stdout, `No matches (${response.empty.reason ?? "no_matches"}).`);
    return;
  }
  response.results.forEach((result, index) => {
    const lines =
      result.location.start_line === null
        ? ""
        : `:${result.location.start_line}${
            result.location.end_line &&
            result.location.end_line !== result.location.start_line
              ? `-${result.location.end_line}`
              : ""
          }`;
    line(
      streams.stdout,
      `${index + 1}. ${knowledgeBasePrefix(result.knowledge_base)}${result.source.relative_path}${lines} (${result.score.toFixed(3)})`,
    );
    line(streams.stdout, result.chunk.content);
    if (index < response.results.length - 1) line(streams.stdout);
  });
}

export type PrepareProgress = {
  stage: "prepare";
  filename: string;
  bytes_total: number;
};

export type IngestionProgress = {
  stage: "ingestion";
  knowledge_base_id: string;
  job_id: string;
  status: string;
  next_action: string;
  progress: IngestionJob["progress"];
};

export type ProgressEvent = PrepareProgress | UploadProgress | IngestionProgress;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function capitalized(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** Text from the API or the user, safe to print on a terminal. */
export function printable(value: string, maxLength = 300): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

/** One line describing where an ingestion job is, e.g. "Parsing: 3/10 files processed". */
export function describeIngestion(
  job: Pick<IngestionJob, "status" | "next_action" | "progress">,
): string {
  const { files, crawl, upload } = job.progress;
  if (job.status === "uploading") {
    if (upload && (job.next_action === "upload_parts" || job.next_action === "complete_upload")) {
      return `Upload incomplete: ${upload.parts_confirmed}/${upload.parts_total} parts received`;
    }
    return "Completing upload";
  }
  if (job.status === "reviewing") return "Paused for your review before indexing";
  if (job.status === "crawling" && crawl) {
    return `Crawling: ${crawl.pages_fetched} pages fetched, ${crawl.pages_indexed} indexed, ${crawl.pages_discovered} discovered`;
  }
  if (files.discovered > 0 && !["ready", "failed", "cancelled"].includes(job.status)) {
    const failed = files.failed > 0 ? `, ${files.failed} failed` : "";
    return `${capitalized(job.status)}: ${files.processed}/${files.discovered} files processed${failed}`;
  }
  return capitalized(job.status);
}

function humanProgress(event: ProgressEvent): string {
  if (event.stage === "prepare") {
    return `Preparing ${printable(event.filename)} (${formatBytes(event.bytes_total)})`;
  }
  if (event.stage === "upload") {
    return `Uploading: ${event.parts_confirmed}/${event.parts_total} parts (${formatBytes(event.bytes_confirmed)} of ${formatBytes(event.bytes_total)})`;
  }
  return describeIngestion(event);
}

/**
 * Reports progress on stderr, leaving stdout for the result: readable lines by
 * default, or one JSON object per line with `--json`. Repeats are dropped, so
 * polling an unchanged job stays quiet.
 */
export function progressWriter(
  streams: OutputStreams,
  json: boolean,
  command: string,
): (event: ProgressEvent) => void {
  let previous = "";
  return (event) => {
    const rendered = json
      ? JSON.stringify({
          schema_version: CLI_SCHEMA_VERSION,
          event: "progress",
          command,
          data: event,
        })
      : humanProgress(event);
    if (rendered === previous) return;
    previous = rendered;
    line(streams.stderr, rendered);
  };
}
