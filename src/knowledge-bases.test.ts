import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArguments } from "./args.js";
import type { CredentialStore } from "./credentials.js";
import { CliError } from "./errors.js";
import { runCli } from "./main.js";
import {
  API_URL,
  apiError,
  FakeKbDrop,
  MANAGEMENT_KEY,
  SERVER_TEXT_CANARY,
} from "./testing/fake-kbdrop.js";
import type { OAuthCredential } from "./types.js";
import { resumeFingerprint } from "./uploads.js";

const apiKey = `kb_live_${"a".repeat(12)}_${"b".repeat(43)}`;
const accessToken = `kb_oauth_at_${"c".repeat(12)}_${"d".repeat(43)}`;
const refreshToken = `kb_oauth_rt_${"e".repeat(12)}_${"f".repeat(43)}`;
const deviceCode = `kb_oauth_dc_${"i".repeat(12)}_${"j".repeat(43)}`;
const MANAGEMENT_SCOPES = "knowledge:read knowledge:query knowledge_bases:read knowledge_bases:write offline_access";
const FILE_BYTES = Buffer.from("kbDrop CLI upload!");

class MemoryStore implements CredentialStore {
  value: OAuthCredential | null = null;
  reads = 0;

  async get(): Promise<OAuthCredential | null> {
    this.reads += 1;
    return this.value;
  }

  async set(_apiUrl: string, value: OAuthCredential): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}

function sink(): { write: (chunk: string | Uint8Array) => boolean; value: () => string } {
  let value = "";
  return {
    write(chunk) {
      value += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    value: () => value,
  };
}

class Clock {
  now = Date.parse("2026-09-24T12:00:00.000Z");
  readonly sleeps: number[] = [];
  readonly sleep = async (milliseconds: number): Promise<void> => {
    this.sleeps.push(milliseconds);
    this.now += milliseconds;
  };
}

type Run = { exitCode: number; stdout: string; stderr: string };

let workspace: string;
let stateDirectory: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kb-drop-cli-test-"));
  stateDirectory = join(workspace, "state");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function run(
  fake: FakeKbDrop,
  argv: string[],
  options: {
    environment?: NodeJS.ProcessEnv;
    store?: CredentialStore;
    clock?: Clock;
  } = {},
): Promise<Run> {
  const stdout = sink();
  const stderr = sink();
  const clock = options.clock ?? new Clock();
  const exitCode = await runCli(argv, {
    store: options.store ?? new MemoryStore(),
    fetchImpl: fake.fetch,
    environment: options.environment ?? {
      NODE_ENV: "test",
      KB_DROP_API_URL: API_URL,
      KB_DROP_MANAGEMENT_KEY: MANAGEMENT_KEY,
      KB_DROP_STATE_DIR: stateDirectory,
    },
    sleep: clock.sleep,
    now: () => clock.now,
    stdout,
    stderr,
  });
  return { exitCode, stdout: stdout.value(), stderr: stderr.value() };
}

async function localFile(name: string, bytes: Buffer = FILE_BYTES): Promise<string> {
  const path = join(workspace, name);
  await writeFile(path, bytes);
  return path;
}

/** The fields tests read directly; `toMatchObject` checks the rest. */
interface CliJson {
  data: {
    upload: { id: string; status: string };
    resumed: boolean;
    idempotency_key: string;
    ingestion_job: object;
  };
  error: { code: string };
}

interface ProgressEvent {
  schema_version: string;
  event: string;
  data: { stage: string };
}

interface CreateBody {
  idempotency_key: string;
  source: object;
}

function json(output: string): CliJson {
  const lines = output.trim().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as CliJson;
}

function progressEvents(stderr: string): ProgressEvent[] {
  return stderr
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProgressEvent);
}

async function pendingRecords(): Promise<string[]> {
  try {
    return await readdir(join(stateDirectory, "pending-operations"));
  } catch {
    return [];
  }
}

/** Nothing sensitive or server-authored reaches the terminal. */
function expectCleanOutput(result: Run): void {
  for (const text of [result.stdout, result.stderr]) {
    expect(text).not.toContain(MANAGEMENT_KEY);
    expect(text).not.toContain(accessToken);
    expect(text).not.toContain("signature=");
    expect(text).not.toContain(workspace);
    expect(text).not.toContain(SERVER_TEXT_CANARY);
  }
}

function createBodies(fake: FakeKbDrop): CreateBody[] {
  return fake
    .apiRequests(/^\/v1\/knowledge-bases$/u)
    .filter((request) => request.method === "POST")
    .map((request) => request.body as CreateBody);
}

describe("knowledge-bases create from a file", () => {
  it("uploads parts in bounded parallel, waits for ingestion, and reports stable JSON", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("product-docs.zip");

    const result = await run(fake, [
      "knowledge-bases",
      "create",
      "--file",
      path,
      "--name",
      "Product docs",
      "--parallel",
      "2",
      "--wait",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const envelope = json(result.stdout);
    expect(envelope).toMatchObject({
      schema_version: "1",
      ok: true,
      command: "knowledge-bases.create",
      data: {
        knowledge_base: { name: "Product docs", queryable: true, status: "ready" },
        ingestion_job: { status: "ready", terminal: true, next_action: "none" },
        upload: { status: "completed", part_count: 5 },
        resumed: false,
      },
    });
    const uploadId = envelope.data.upload.id;
    expect(fake.storedBytes(uploadId).equals(FILE_BYTES)).toBe(true);
    expect(fake.maxInFlightPuts).toBe(2);
    expect(fake.storagePuts).toHaveLength(5);

    const [body] = createBodies(fake);
    expect(body).toEqual({
      idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      name: "Product docs",
      source: {
        type: "upload",
        filename: "product-docs.zip",
        size_bytes: FILE_BYTES.length,
        fingerprint: expect.stringMatching(/^sha256-tree-v1:[0-9a-f]{64}$/u),
      },
    });
    expect(envelope.data.idempotency_key).toBe(body!.idempotency_key);
    // Storage never sees the kbDrop credential; the API never sees the local path.
    for (const request of fake.requests) {
      if (request.url.startsWith(API_URL)) {
        expect(request.authorization).toBe(`Bearer ${MANAGEMENT_KEY}`);
        expect(JSON.stringify(request.body ?? null)).not.toContain(workspace);
      } else {
        expect(request.method).toBe("PUT");
        expect(request.authorization).toBeNull();
      }
    }

    const events = progressEvents(result.stderr);
    expect(events.every((event) => event.schema_version === "1" && event.event === "progress")).toBe(true);
    expect(events[0]).toMatchObject({
      command: "knowledge-bases.create",
      data: { stage: "prepare", filename: "product-docs.zip", bytes_total: FILE_BYTES.length },
    });
    expect(events.filter((event) => event.data.stage === "upload").at(-1)).toMatchObject({
      data: { parts_confirmed: 5, parts_total: 5, bytes_confirmed: FILE_BYTES.length },
    });
    expect(events.at(-1)).toMatchObject({ data: { stage: "ingestion", status: "ready" } });
    expectCleanOutput(result);
    expect(await pendingRecords()).toEqual([]);
  });

  it("prints readable progress and next steps without --json", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("guide.zip");

    const result = await run(fake, ["kb", "create", "--zip", path]);

    expect(result.exitCode).toBe(0);
    const [knowledgeBase] = [...fake.knowledgeBases.values()];
    expect(result.stdout).toBe(
      [
        `Created knowledge base "guide.zip" (${knowledgeBase!.id}).`,
        "Queued.",
        `Follow progress with: kb-drop knowledge-bases status ${knowledgeBase!.id} --watch`,
        "",
      ].join("\n"),
    );
    expect(result.stderr).toContain(`Preparing guide.zip (${FILE_BYTES.length} B)`);
    expect(result.stderr).toContain("Uploading: 5/5 parts (18 B of 18 B)");
    expectCleanOutput(result);
  });

  it("resumes an interrupted upload without a second knowledge base or resending stored parts", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("manual.zip");
    fake.onPut = (partNumber) =>
      partNumber === 3 ? new TypeError("socket hang up") : undefined;
    const argv = ["kb", "create", "--file", path, "--parallel", "1", "--json"];

    const interrupted = await run(fake, argv);

    expect(interrupted.exitCode).toBe(6);
    expect(json(interrupted.stderr.trim().split("\n").at(-1)!)).toMatchObject({
      ok: false,
      error: { code: "storage_upload_failed" },
    });
    const [upload] = [...fake.uploads.values()];
    expect(upload!.confirmed.size).toBe(2);
    expect(await pendingRecords()).toHaveLength(1);

    fake.onPut = () => undefined;
    const resumed = await run(fake, argv.filter((argument) => argument !== "--json"));

    expect(resumed.exitCode).toBe(0);
    expect(fake.knowledgeBases.size).toBe(1);
    const [first, second] = createBodies(fake);
    expect(second!.idempotency_key).toBe(first!.idempotency_key);
    const putsPerPart = new Map<number, number>();
    for (const put of fake.storagePuts) {
      putsPerPart.set(put.partNumber, (putsPerPart.get(put.partNumber) ?? 0) + 1);
    }
    expect([...putsPerPart.entries()].sort(([a], [b]) => a - b)).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
    ]);
    expect(fake.storedBytes(upload!.id).equals(FILE_BYTES)).toBe(true);
    expect(resumed.stdout).toContain(`Resumed knowledge base "manual.zip" (${upload!.knowledgeBaseId}).`);
    expect(resumed.stderr).toContain("Uploading: 2/5 parts");
    expect(await pendingRecords()).toEqual([]);

    // A finished command is not resumed: running it again creates another knowledge base.
    const again = await run(fake, argv);
    expect(again.exitCode).toBe(0);
    expect(fake.knowledgeBases.size).toBe(2);
    expect(createBodies(fake)[2]!.idempotency_key).not.toBe(first!.idempotency_key);
  });

  it("starts over under a new key when the interrupted upload has expired", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("expired.zip");
    fake.onPut = (partNumber) => (partNumber === 2 ? new TypeError("reset") : undefined);
    const argv = ["kb", "create", "--file", path, "--parallel", "1"];
    expect((await run(fake, argv)).exitCode).toBe(6);
    const [abandoned] = [...fake.uploads.values()];
    fake.abortUpload(abandoned!.id);
    fake.onPut = () => undefined;

    const result = await run(fake, argv);

    expect(result.exitCode).toBe(0);
    expect(fake.knowledgeBases.size).toBe(2);
    const keys = createBodies(fake).map((body) => body.idempotency_key);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(result.stderr).toContain("The interrupted upload expired; starting a new knowledge base.");
    expect(result.stdout).toMatch(/^Created knowledge base "expired.zip"/u);
    expect(await pendingRecords()).toEqual([]);
  });

  it("re-signs refused part URLs and backs off from throttled storage", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("retry.zip");
    const clock = new Clock();
    fake.onPut = (partNumber, attempt) => {
      if (partNumber === 1 && attempt === 1) fake.expireSignatures();
      if (partNumber === 2 && attempt === 1) return new Response("SlowDown", { status: 503 });
      return undefined;
    };

    const result = await run(fake, ["kb", "create", "--file", path, "--parallel", "1", "--json"], {
      clock,
    });

    expect(result.exitCode).toBe(0);
    const signing = fake
      .apiRequests(/\/part-urls$/u)
      .map((request) => (request.body as { part_numbers: number[] }).part_numbers);
    expect(signing).toContainEqual([1]);
    expect(signing.filter((parts) => parts.length === 1 && parts[0] === 1)).toHaveLength(2);
    expect(clock.sleeps.some((milliseconds) => milliseconds >= 1_000 && milliseconds < 1_250)).toBe(true);
    expect(fake.storedBytes(json(result.stdout).data.upload.id).equals(FILE_BYTES)).toBe(true);
  });

  it("uploads parts again that storage rejected during assembly, with a write-only key", async () => {
    const fake = new FakeKbDrop();
    fake.credentials.set(MANAGEMENT_KEY, new Set(["knowledge_bases:write"]));
    fake.rejectOnComplete = [2];
    const path = await localFile("rejected.zip");

    const result = await run(fake, ["kb", "create", "--file", path, "--json"]);

    expect(result.exitCode).toBe(0);
    const signing = fake
      .apiRequests(/\/part-urls$/u)
      .map((request) => (request.body as { part_numbers: number[] }).part_numbers);
    expect(signing.at(-1)).toEqual([2]);
    const upload = json(result.stdout).data.upload;
    expect(upload.status).toBe("completed");
    expect(fake.storedBytes(upload.id).equals(FILE_BYTES)).toBe(true);
    expect(fake.knowledgeBases.size).toBe(1);
  });

  it("recovers a lost response and waits while the server opens and assembles the upload", async () => {
    const fake = new FakeKbDrop();
    fake.lostCreateResponses = 1;
    fake.initializingReplies = 2;
    fake.completingReplies = 1;
    const clock = new Clock();
    const path = await localFile("slow.zip");

    const result = await run(fake, ["kb", "create", "--file", path, "--json"], { clock });

    expect(result.exitCode).toBe(0);
    const keys = createBodies(fake).map((body) => body.idempotency_key);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(1);
    expect(fake.knowledgeBases.size).toBe(1);
    expect(clock.sleeps.filter((milliseconds) => milliseconds === 1_000)).toHaveLength(2);
    expect(clock.sleeps).toContain(2_000);
    expect(json(result.stdout).data).toMatchObject({
      resumed: false,
      upload: { status: "completed" },
      ingestion_job: { status: "queued" },
    });
  });

  it("refuses to upload a file that changes during the upload", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("moving.zip");
    fake.onPut = (partNumber, attempt) => {
      if (partNumber === 2 && attempt === 1) {
        appendFileSync(path, "more");
        return new TypeError("reset");
      }
      return undefined;
    };

    const result = await run(fake, ["kb", "create", "--file", path, "--parallel", "1", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(json(result.stderr.trim().split("\n").at(-1)!).error.code).toBe("file_changed");
  });
});

describe("knowledge-bases create from a URL", () => {
  it("sends every crawl setting the browser offers and nothing that was not given", async () => {
    const fake = new FakeKbDrop();

    const result = await run(fake, [
      "kb",
      "create",
      "--url",
      "https://docs.example.com",
      "--name",
      "Public docs",
      "--mode",
      "site",
      "--max-pages",
      "100",
      "--max-depth",
      "2",
      "--include-path",
      "/docs/*",
      "--include-path=/guides/*",
      "--exclude-path",
      "/blog/*",
      "--include-subdomains",
      "--allow-documents",
      "--render-mode",
      "always",
      "--query-policy",
      "strip",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(createBodies(fake)[0]).toEqual({
      idempotency_key: expect.any(String),
      name: "Public docs",
      source: {
        type: "web",
        url: "https://docs.example.com",
        mode: "site",
        include_paths: ["/docs/*", "/guides/*"],
        exclude_paths: ["/blog/*"],
        query_policy: "strip",
        render_mode: "always",
        include_subdomains: true,
        allow_documents: true,
        max_pages: 100,
        max_depth: 2,
      },
    });
    expect(json(result.stdout).data).toMatchObject({
      upload: null,
      ingestion_job: { status: "queued", next_action: "wait" },
    });

    const minimal = await run(fake, ["kb", "create", "--url=https://docs.example.com/?a=b&c=d"]);
    expect(minimal.exitCode).toBe(0);
    expect(createBodies(fake)[1]!.source).toEqual({
      type: "web",
      url: "https://docs.example.com/?a=b&c=d",
    });

    const video = await run(fake, [
      "kb",
      "create",
      "--video-url",
      "https://videos.example.com/talk.mp4",
      "--name",
      "Talk",
    ]);
    expect(video.exitCode).toBe(0);
    expect(createBodies(fake)[2]).toMatchObject({
      name: "Talk",
      source: { type: "video_url", url: "https://videos.example.com/talk.mp4" },
    });
  });

  it("exits 9 when ingestion fails and explains the next step", async () => {
    const fake = new FakeKbDrop();
    fake.jobScript = ["parsing", "failed"];

    const failed = await run(fake, ["kb", "create", "--url", "https://docs.example.com", "--wait", "--json"]);

    expect(failed.exitCode).toBe(9);
    expect(json(failed.stdout).data.ingestion_job).toMatchObject({
      status: "failed",
      next_action: "retry",
      failure: { stage: "parsing", recovery: "retry", retryable: true },
    });
    expect(await pendingRecords()).toEqual([]);

    const human = await run(fake, ["kb", "create", "--url", "https://docs.example.com", "--wait"]);
    const [, second] = [...fake.knowledgeBases.values()];
    expect(human.exitCode).toBe(9);
    expect(human.stdout).toContain("Failed while parsing: The parser stopped unexpectedly.");
    expect(human.stdout).toContain(`Retry with: kb-drop knowledge-bases retry ${second!.id}`);
  });

  it("exits 10 when the wait times out, and resumes the same knowledge base when rerun", async () => {
    const fake = new FakeKbDrop();
    fake.jobScript = Array.from({ length: 100 }, () => "parsing");
    const clock = new Clock();
    const argv = [
      "kb",
      "create",
      "--url",
      "https://docs.example.com",
      "--wait",
      "--wait-timeout",
      "30",
      "--json",
    ];

    const timedOut = await run(fake, argv, { clock });

    expect(timedOut.exitCode).toBe(10);
    expect(json(timedOut.stdout).data.ingestion_job).toMatchObject({
      status: "parsing",
      terminal: false,
    });
    expect(clock.sleeps.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(30_000);
    expect(await pendingRecords()).toHaveLength(1);

    const rerun = await run(fake, argv, { clock });
    expect(rerun.exitCode).toBe(10);
    expect(fake.knowledgeBases.size).toBe(1);
    expect(json(rerun.stdout).data.resumed).toBe(true);
  });
});

describe("knowledge-bases status, list, retry, and recrawl", () => {
  it("reports status without waiting, and --watch follows the job to the end", async () => {
    const fake = new FakeKbDrop();
    const { knowledgeBaseId, jobId } = fake.addKnowledgeBase({
      name: "Docs",
      source: { type: "web", url: "https://docs.example.com", mode: "site" },
      status: "crawling",
    });
    fake.jobs.get(jobId)!.script = ["crawling", "embedding", "embedding", "ready"];

    const snapshot = await run(fake, ["kb", "status", knowledgeBaseId, "--json"]);
    expect(snapshot.exitCode).toBe(0);
    expect(json(snapshot.stdout)).toMatchObject({
      command: "knowledge-bases.status",
      data: {
        knowledge_base: { id: knowledgeBaseId, queryable: false },
        ingestion_job: { id: jobId, status: "crawling", terminal: false },
      },
    });

    const watched = await run(fake, ["kb", "status", "--kb", knowledgeBaseId, "--watch"]);
    expect(watched.exitCode).toBe(0);
    expect(watched.stdout).toBe(
      [
        `Docs (${knowledgeBaseId})`,
        "Source:    https://docs.example.com (website, site)",
        "Status:    Ready.",
        "Queryable: yes (version 1)",
        `Next:      Ask it with: kb-drop ask --kb ${knowledgeBaseId} "your question"`,
        "",
      ].join("\n"),
    );
    expect(watched.stderr).toContain("Embedding: ");
  });

  it("stops watching at once when the upload is waiting on the client", async () => {
    const fake = new FakeKbDrop();
    const path = await localFile("paused.zip");
    fake.onPut = (partNumber) => (partNumber === 4 ? new TypeError("reset") : undefined);
    await run(fake, ["kb", "create", "--file", path, "--parallel", "1"]);
    const [knowledgeBase] = [...fake.knowledgeBases.values()];
    const clock = new Clock();

    const result = await run(fake, ["kb", "status", knowledgeBase!.id, "--watch"], { clock });

    expect(result.exitCode).toBe(10);
    expect(clock.sleeps).toEqual([]);
    expect(result.stdout).toContain("Status:    Upload incomplete: 3/5 parts received.");
    expect(result.stdout).toContain(
      "Next:      The upload is incomplete. Run the same create command again to resume it.",
    );
  });

  it("lists knowledge bases a page at a time", async () => {
    const fake = new FakeKbDrop();
    const ids = ["One", "Two", "Three"].map(
      (name) =>
        fake.addKnowledgeBase({
          name,
          source: { type: "web", url: "https://docs.example.com", mode: "site" },
          status: "ready",
        }).knowledgeBaseId,
    );

    const first = await run(fake, ["kb", "list", "--limit", "2", "--json"]);
    expect(first.exitCode).toBe(0);
    expect(json(first.stdout).data).toMatchObject({
      object: "list",
      has_more: true,
      next_cursor: "2",
      data: [{ id: ids[0] }, { id: ids[1] }],
    });
    expect(fake.apiRequests(/^\/v1\/knowledge-bases$/u)[0]!.url).toBe(
      `${API_URL}/v1/knowledge-bases?limit=2`,
    );

    const second = await run(fake, ["knowledge-bases", "list", "--limit", "2", "--cursor", "2"]);
    expect(second.stdout).toBe(`${ids[2]}  ready       Three\n`);
  });

  it("retries a failed job once, even when the command is repeated", async () => {
    const fake = new FakeKbDrop();
    const { knowledgeBaseId, jobId } = fake.addKnowledgeBase({
      name: "Flaky",
      source: { type: "web", url: "https://docs.example.com", mode: "site" },
      status: "failed",
    });

    const retried = await run(fake, ["kb", "retry", knowledgeBaseId, "--wait", "--json"]);

    expect(retried.exitCode).toBe(0);
    expect(fake.apiRequests(/\/retry$/u).map((request) => request.body)).toEqual([{ attempt: 1 }]);
    expect(json(retried.stdout).data.ingestion_job).toMatchObject({
      id: jobId,
      attempt: 2,
      status: "ready",
    });

    const repeated = await run(fake, ["kb", "retry", knowledgeBaseId, "--json"]);
    expect(repeated.exitCode).toBe(4);
    expect(json(repeated.stderr).error).toMatchObject({
      code: "ingestion_job_succeeded",
      message: "The latest ingestion job succeeded, so there is nothing to retry.",
    });
    expect(fake.apiRequests(/\/retry$/u)).toHaveLength(1);

    const unrecoverable = fake.addKnowledgeBase({
      name: "Broken",
      source: { type: "web", url: "https://docs.example.com", mode: "site" },
      status: "failed",
      failure: { stage: "parsing", recovery: "contact_support", message: "Internal." },
    });
    const refused = await run(fake, ["kb", "retry", unrecoverable.knowledgeBaseId]);
    expect(refused.exitCode).toBe(4);
    expect(refused.stderr).toBe(
      "kb-drop: This failure cannot be retried. (ingestion_needs_support) Contact support and quote the request ID.\n",
    );
  });

  it("recrawls a website under one idempotency key and refuses other sources", async () => {
    const fake = new FakeKbDrop();
    const website = fake.addKnowledgeBase({
      name: "Site",
      source: { type: "web", url: "https://docs.example.com", mode: "site" },
      status: "ready",
    });

    const recrawled = await run(fake, ["kb", "recrawl", website.knowledgeBaseId, "--wait", "--json"]);

    expect(recrawled.exitCode).toBe(0);
    const [request] = fake.apiRequests(/\/crawls$/u);
    expect(request!.body).toEqual({ idempotency_key: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
    expect(json(recrawled.stdout).data).toMatchObject({
      resumed: false,
      knowledge_base: { active_version: 2, queryable: true },
      ingestion_job: { version: 2, status: "ready" },
    });
    expect(await pendingRecords()).toEqual([]);

    const upload = fake.addKnowledgeBase({
      name: "Files",
      source: { type: "upload", filename: "a.zip", size_bytes: 10 },
      status: "ready",
    });
    const refused = await run(fake, ["kb", "recrawl", upload.knowledgeBaseId, "--json"]);
    expect(refused.exitCode).toBe(4);
    expect(json(refused.stderr).error).toMatchObject({
      code: "knowledge_base_not_crawlable",
      message: "Only knowledge bases created from a website can be crawled again.",
      recovery: "fix_request",
    });
  });
});

describe("management credentials", () => {
  it("never sends a knowledge-base API key or a query-only login to management endpoints", async () => {
    const fake = new FakeKbDrop();

    const apiKeyOnly = await run(fake, ["kb", "list", "--json"], {
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL, KB_DROP_API_KEY: apiKey },
    });
    expect(apiKeyOnly.exitCode).toBe(3);
    expect(json(apiKeyOnly.stderr).error.code).toBe("management_login_required");

    const store = new MemoryStore();
    store.value = {
      version: 1,
      apiUrl: API_URL,
      accessToken,
      accessExpiresAt: "2026-09-24T13:00:00.000Z",
      refreshToken,
      scope: "knowledge:read knowledge:query offline_access",
      account: { email: "agent@example.com" },
    };
    const queryOnly = await run(fake, ["kb", "list", "--json"], {
      store,
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL },
    });
    expect(queryOnly.exitCode).toBe(3);
    expect(json(queryOnly.stderr).error.code).toBe("management_scope_required");
    expect(fake.requests).toEqual([]);

    store.value = { ...store.value, scope: MANAGEMENT_SCOPES };
    fake.credentials.set(accessToken, new Set(["knowledge_bases:read", "knowledge_bases:write"]));
    const managed = await run(fake, ["kb", "list", "--json"], {
      store,
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL },
    });
    expect(managed.exitCode).toBe(0);
    expect(fake.requests.map((request) => request.authorization)).toEqual([`Bearer ${accessToken}`]);
  });

  it("reports a missing server-side scope as an authorization failure", async () => {
    const fake = new FakeKbDrop();
    fake.credentials.set(MANAGEMENT_KEY, new Set(["knowledge_bases:write"]));

    const result = await run(fake, ["kb", "list", "--json"]);

    expect(result.exitCode).toBe(3);
    expect(json(result.stderr).error).toMatchObject({
      code: "management_key_scope_insufficient",
      status: 403,
      recovery: "request_scope",
      message: "The management key does not have the permission this command needs.",
    });
    expectCleanOutput(result);
  });

  it("explains quota refusals with the CLI's own words and the server's recovery", async () => {
    const fake = new FakeKbDrop();
    fake.onCreate = () => apiError(403, "storage_quota_exceeded", "ask_account_owner");

    const machine = await run(fake, ["kb", "create", "--url", "https://docs.example.com", "--json"]);
    expect(machine.exitCode).toBe(4);
    expect(json(machine.stderr).error).toEqual({
      code: "storage_quota_exceeded",
      message: "The account's storage quota is used up.",
      status: 403,
      recovery: "ask_account_owner",
    });

    const human = await run(fake, ["kb", "create", "--url", "https://docs.example.com"]);
    expect(human.stderr).toBe(
      "kb-drop: The account's storage quota is used up. (storage_quota_exceeded) The account needs more quota or a plan change.\n",
    );
    expectCleanOutput(human);
  });

  it("requests management scopes only for auth login --manage", async () => {
    for (const granted of [MANAGEMENT_SCOPES, "knowledge:read knowledge:query offline_access"]) {
      const store = new MemoryStore();
      const requestedScopes: string[] = [];
      const clock = new Clock();
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            issuer: API_URL,
            authorization_endpoint: `${API_URL}/oauth/authorize`,
            token_endpoint: `${API_URL}/oauth/token`,
            revocation_endpoint: `${API_URL}/oauth/revoke`,
            device_authorization_endpoint: `${API_URL}/oauth/device/code`,
          });
        }
        if (url.endsWith("/oauth/device/code")) {
          requestedScopes.push(new URLSearchParams(String(init?.body)).get("scope") ?? "");
          return Response.json({
            device_code: deviceCode,
            user_code: "ABCD-EFGH",
            verification_uri: `${API_URL}/oauth/device`,
            verification_uri_complete: `${API_URL}/oauth/device?user_code=ABCD-EFGH`,
            expires_in: 120,
            interval: 5,
          });
        }
        if (url.endsWith("/oauth/token")) {
          return Response.json({
            access_token: accessToken,
            token_type: "Bearer",
            expires_in: 900,
            refresh_token: refreshToken,
            scope: granted,
            account: { email: "owner@example.com" },
          });
        }
        throw new Error("Unexpected request");
      };
      const stdout = sink();
      const stderr = sink();
      const exitCode = await runCli(
        ["auth", "login", "--manage", "--device", "--no-browser", "--api-url", API_URL],
        {
          store,
          fetchImpl,
          sleep: clock.sleep,
          now: () => clock.now,
          environment: { NODE_ENV: "test" },
          stdout,
          stderr,
        },
      );
      expect(requestedScopes).toEqual([MANAGEMENT_SCOPES]);
      if (granted === MANAGEMENT_SCOPES) {
        expect(exitCode).toBe(0);
        expect(stdout.value()).toBe(
          `Logged in to ${API_URL} as owner@example.com, with knowledge-base management.\n`,
        );
      } else {
        expect(exitCode).toBe(3);
        expect(stderr.value()).toContain("(management_scope_not_granted)");
      }
    }
  });

  it("shows which credential knowledge-base commands will use", async () => {
    const fake = new FakeKbDrop();
    const fromKey = await run(fake, ["auth", "status", "--json"]);
    expect(json(fromKey.stdout).data).toMatchObject({
      authenticated: true,
      source: "environment",
      management: "environment",
    });

    const store = new MemoryStore();
    store.value = {
      version: 1,
      apiUrl: API_URL,
      accessToken,
      accessExpiresAt: "2026-09-24T13:00:00.000Z",
      refreshToken,
      scope: MANAGEMENT_SCOPES,
      account: { email: "owner@example.com" },
    };
    const fromLogin = await run(fake, ["auth", "status"], {
      store,
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL, KB_DROP_API_KEY: apiKey },
    });
    expect(fromLogin.stdout).toBe(
      `Authenticated to ${API_URL} with KB_DROP_API_KEY.\nKnowledge-base management: allowed by the saved login.\n`,
    );

    const none = await run(fake, ["auth", "status", "--json"], {
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL },
    });
    expect(json(none.stdout).data).toMatchObject({ authenticated: false, management: null });
  });
});

describe("long-running commands on a saved login", () => {
  // No KB_DROP_MANAGEMENT_KEY, so management commands use the saved login.
  const loginEnvironment = (): NodeJS.ProcessEnv => ({
    NODE_ENV: "test",
    KB_DROP_API_URL: API_URL,
    KB_DROP_STATE_DIR: stateDirectory,
  });

  function managedLogin(fake: FakeKbDrop, clock: Clock, expiresInSeconds: number): MemoryStore {
    fake.now = () => clock.now;
    const store = new MemoryStore();
    store.value = fake.savedLogin({ scope: MANAGEMENT_SCOPES, expiresInSeconds });
    return store;
  }

  it("refreshes the login when a wait outlasts its access token", async () => {
    const fake = new FakeKbDrop();
    const clock = new Clock();
    const store = managedLogin(fake, clock, 900);
    const first = store.value!.accessToken;
    // About 20 minutes of ingestion against a 15-minute access token.
    fake.pollAfterSeconds = 30;
    fake.jobScript = [...Array<string>(40).fill("embedding"), "ready"];

    const result = await run(
      fake,
      ["kb", "create", "--url", "https://docs.example.com", "--wait", "--json"],
      { store, clock, environment: loginEnvironment() },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fake.refreshGrants).toEqual(["issued"]);
    const bearers = new Set(fake.apiRequests().map((request) => request.authorization));
    expect([...bearers]).toEqual([`Bearer ${first}`, `Bearer ${store.value!.accessToken}`]);
  });

  it("refreshes once for parallel parts that need a new login at the same moment", async () => {
    const fake = new FakeKbDrop();
    const clock = new Clock();
    const store = managedLogin(fake, clock, 900);
    const expiresAt = Date.parse(store.value!.accessExpiresAt);
    // Every part's first PUT stalls until both its signature and the login expire.
    fake.onPut = (_partNumber, attempt) => {
      if (attempt > 1) return undefined;
      clock.now = Math.max(clock.now, expiresAt);
      return new Response(null, { status: 403 });
    };
    const file = await localFile("notes.pdf");

    const result = await run(fake, ["kb", "create", "--file", file, "--parallel", "4", "--json"], {
      store,
      clock,
      environment: loginEnvironment(),
    });

    expect(result.exitCode, result.stderr).toBe(0);
    // A second refresh would reuse the first refresh token and revoke the login.
    expect(fake.refreshGrants).toEqual(["issued"]);
    expect(fake.storedBytes(json(result.stdout).data.upload.id)).toEqual(FILE_BYTES);
  });

  it("sends a request again when its token expired while it waited out a retry", async () => {
    const fake = new FakeKbDrop();
    const clock = new Clock();
    const store = managedLogin(fake, clock, 45);
    const first = store.value!.accessToken;
    let creates = 0;
    fake.onCreate = () =>
      (creates += 1) <= 2
        ? apiError(503, "service_unavailable", "retry_later", { "Retry-After": "30" })
        : undefined;

    const result = await run(fake, ["kb", "create", "--url", "https://docs.example.com", "--json"], {
      store,
      clock,
      environment: loginEnvironment(),
    });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fake.refreshGrants).toEqual(["issued"]);
    expect(
      fake.apiRequests(/^\/v1\/knowledge-bases$/u).map((request) => request.authorization),
    ).toEqual([
      `Bearer ${first}`,
      `Bearer ${first}`,
      `Bearer ${first}`,
      `Bearer ${store.value!.accessToken}`,
    ]);
  });

  it("reports KB_DROP_API_KEY from auth status when no OS keychain is available", async () => {
    const fake = new FakeKbDrop();
    const unavailable = async (): Promise<never> => {
      throw new CliError("auth", "keychain_unavailable", "No native OS credential store is available.");
    };
    const noKeychain: CredentialStore = { get: unavailable, set: unavailable, delete: unavailable };

    const withKey = await run(fake, ["auth", "status", "--json"], {
      store: noKeychain,
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL, KB_DROP_API_KEY: apiKey },
    });
    expect(withKey.exitCode, withKey.stderr).toBe(0);
    expect(json(withKey.stdout).data).toMatchObject({
      authenticated: true,
      source: "environment",
      management: null,
    });

    const withoutKey = await run(fake, ["auth", "status", "--json"], {
      store: noKeychain,
      environment: { NODE_ENV: "test", KB_DROP_API_URL: API_URL },
    });
    expect(withoutKey.exitCode).toBe(3);
    expect(json(withoutKey.stderr).error.code).toBe("keychain_unavailable");
  });
});

describe("argument validation", () => {
  it("rejects invalid requests before contacting kbDrop", async () => {
    const fake = new FakeKbDrop();
    const file = await localFile("notes.pdf");
    const empty = await localFile("empty.zip", Buffer.alloc(0));
    const directory = join(workspace, "folder");
    await mkdir(directory);
    const cases: Array<[string[], string]> = [
      [["kb", "create"], "source_required"],
      [["kb", "create", "--file", file, "--url", "https://a.example"], "source_conflict"],
      [["kb", "create", "--file", file, "--max-pages", "5"], "web_option_requires_url"],
      [["kb", "create", "--url", "https://a.example", "--parallel", "2"], "parallel_requires_file"],
      [["kb", "create", "--zip", file], "zip_required"],
      [["kb", "create", "--file", file, "--wait-timeout", "5"], "wait_timeout_requires_wait"],
      [["kb", "create", "--url", "https://a.example", "--include-path", "docs"], "path_pattern_invalid"],
      [["kb", "create", "--url", "https://a.example", "--mode", "everything"], "invalid_option_value"],
      [["kb", "create", "--url", "https://a.example", "--max-pages", "1001"], "invalid_option_value"],
      [["kb", "create", "--url", "ftp://a.example"], "url_invalid"],
      [["kb", "create", "--url", "https://a.example", "--name", "x".repeat(121)], "name_invalid"],
      [["kb", "create", "--url", "https://a.example", "--idempotency-key", "abc"], "uuid_invalid"],
      [["kb", "create", "--file", join(workspace, "missing.zip")], "file_unreadable"],
      [["kb", "create", "--file", directory], "file_not_regular"],
      [["kb", "create", "--file", empty], "file_empty"],
      [["kb", "create", "--url", "https://a.example", "--management-key", "x"], "secret_argument_forbidden"],
      [["kb", "create", "--url", "https://a.example", "--top-k", "3"], "option_not_supported"],
      [["kb", "status"], "knowledge_base_required"],
      [["kb", "status", "not-a-uuid"], "knowledge_base_invalid"],
      [["kb", "delete"], "knowledge_base_command_required"],
      [["kb"], "knowledge_base_command_required"],
    ];
    for (const [argv, code] of cases) {
      const result = await run(fake, [...argv, "--json"]);
      expect({ argv, exitCode: result.exitCode, code: json(result.stderr).error.code }).toEqual({
        argv,
        exitCode: 2,
        code,
      });
    }
    expect(fake.requests).toEqual([]);
  });

  it("keeps values that contain '=' and repeats only repeatable options", () => {
    const parsed = parseArguments([
      "kb",
      "create",
      "--url=https://docs.example.com/?a=b&c=d",
      "--include-path=/docs/*",
      "--include-path",
      "/guides/*",
    ]);
    expect(parsed.options.get("url")).toEqual(["https://docs.example.com/?a=b&c=d"]);
    expect(parsed.options.get("include-path")).toEqual(["/docs/*", "/guides/*"]);
  });
});

describe("resume fingerprint", () => {
  it("matches the browser's sha256-tree-v1 fingerprint", async () => {
    const single = await localFile("single.txt", Buffer.from("kbDrop resume fingerprint\n"));
    const bytes = Buffer.from(Array.from({ length: 40 }, (_, index) => index));
    const chunked = await localFile("chunked.bin", bytes);

    await expect(resumeFingerprint({ path: single, sizeBytes: 26 })).resolves.toBe(
      "sha256-tree-v1:5fe36c196025fcb128243b33aceabc7839374bc29abec73bc4a2447246bedd7a",
    );
    await expect(resumeFingerprint({ path: chunked, sizeBytes: 40 }, 16)).resolves.toBe(
      "sha256-tree-v1:326f676048561f6068b51b667b4d65fea363defe864fe26b73fea4a534f027ac",
    );
  });
});
