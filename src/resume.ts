import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { UUID_PATTERN } from "./management.js";

const RECORD_VERSION = 1;
// Resume exists for interruptions. After a day the same command starts over
// instead of replaying an old request.
const RECORD_TTL_MS = 24 * 60 * 60 * 1_000;

export type PendingOperation = {
  idempotencyKey: string;
  /** An earlier, interrupted run of the same command left this key behind. */
  resumed: boolean;
  /** Replaces the key after the server reported the earlier attempt unusable. */
  restart(): Promise<string>;
  /** Forgets the key, so running the same command again starts a new operation. */
  finish(): Promise<void>;
};

export type RetryTarget = { jobId: string; attempt: number };

export type PendingRetry = {
  /** The failed attempt an earlier, interrupted run already asked to retry. */
  target: RetryTarget | null;
  /** Remembers the failed attempt before its retry is sent. */
  save(target: RetryTarget): Promise<void>;
  /** Forgets the attempt, so running the same command again retries anew. */
  finish(): Promise<void>;
};

/**
 * Where interrupted operations are remembered: KB_DROP_STATE_DIR, else the
 * platform's per-user state directory. Records hold an idempotency key, or a
 * retried job's ID and attempt, and a timestamp, never credentials, paths, or
 * file contents.
 */
export function stateDirectory(environment: NodeJS.ProcessEnv): string {
  if (environment.KB_DROP_STATE_DIR) return resolve(environment.KB_DROP_STATE_DIR);
  if (process.platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "kb-drop");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "kb-drop");
  }
  return join(environment.XDG_STATE_HOME || join(homedir(), ".local", "state"), "kb-drop");
}

function unavailable(alternative: string): CliError {
  return new CliError(
    "usage",
    "state_directory_unavailable",
    `Resume state could not be saved. Set KB_DROP_STATE_DIR to a writable directory${alternative}.`,
  );
}

/**
 * The file that remembers one request between runs, named by a digest of the
 * API URL and the request. `read` returns its fields while they are current.
 */
function pendingRecord(input: {
  environment: NodeJS.ProcessEnv;
  apiUrl: string;
  request: unknown;
  now: number;
  /** How to proceed without a state directory, if there is another way. */
  alternative: string;
}) {
  const directory = join(stateDirectory(input.environment), "pending-operations");
  const digest = createHash("sha256")
    .update(JSON.stringify({ api_url: input.apiUrl, request: input.request }))
    .digest("hex");
  const path = join(directory, `${digest}.json`);

  return {
    async read(): Promise<Record<string, unknown> | null> {
      let encoded: string;
      try {
        encoded = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw unavailable(input.alternative);
      }
      try {
        const value = JSON.parse(encoded) as Record<string, unknown>;
        const createdAt = Date.parse(String(value.created_at));
        if (
          value.version === RECORD_VERSION &&
          Number.isFinite(createdAt) &&
          input.now - createdAt < RECORD_TTL_MS &&
          createdAt <= input.now + 60_000
        ) {
          return value;
        }
      } catch {
        // A damaged record is replaced when the command saves its own.
      }
      return null;
    },
    async save(fields: Record<string, unknown>): Promise<void> {
      const record = {
        version: RECORD_VERSION,
        ...fields,
        created_at: new Date(input.now).toISOString(),
      };
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        await rename(temporary, path);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw unavailable(input.alternative);
      }
    },
    async remove(): Promise<void> {
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}

/**
 * Binds one request to an idempotency key that survives the process. The key
 * is saved before anything is sent, so rerunning the same command after a
 * crash, kill, or network failure resumes the same knowledge base, upload, and
 * reservations instead of creating new ones.
 */
export async function pendingOperation(input: {
  environment: NodeJS.ProcessEnv;
  apiUrl: string;
  /** The request without its idempotency key. */
  request: unknown;
  now: number;
}): Promise<PendingOperation> {
  const record = pendingRecord({ ...input, alternative: ", or pass --idempotency-key" });
  const saved = await record.read();
  const existing =
    typeof saved?.idempotency_key === "string" && UUID_PATTERN.test(saved.idempotency_key)
      ? saved.idempotency_key
      : null;
  const pending: PendingOperation = {
    idempotencyKey: existing ?? randomUUID(),
    resumed: existing !== null,
    async restart() {
      pending.idempotencyKey = randomUUID();
      pending.resumed = false;
      await record.save({ idempotency_key: pending.idempotencyKey });
      return pending.idempotencyKey;
    },
    finish: () => record.remove(),
  };
  if (!existing) await record.save({ idempotency_key: pending.idempotencyKey });
  return pending;
}

/**
 * Remembers which failed attempt a retry named. The attempt is what makes a
 * retry idempotent, so rerunning an interrupted retry replays it and follows
 * that attempt, instead of retrying whichever attempt is latest by then.
 */
export async function pendingRetry(input: {
  environment: NodeJS.ProcessEnv;
  apiUrl: string;
  knowledgeBaseId: string;
  now: number;
}): Promise<PendingRetry> {
  const record = pendingRecord({
    environment: input.environment,
    apiUrl: input.apiUrl,
    request: { operation: "retry", knowledge_base_id: input.knowledgeBaseId },
    now: input.now,
    alternative: "",
  });
  const saved = await record.read();
  const target =
    typeof saved?.job_id === "string" &&
    UUID_PATTERN.test(saved.job_id) &&
    typeof saved.attempt === "number" &&
    Number.isSafeInteger(saved.attempt) &&
    saved.attempt >= 1
      ? { jobId: saved.job_id, attempt: saved.attempt }
      : null;
  return {
    target,
    save: ({ jobId, attempt }) => record.save({ job_id: jobId, attempt }),
    finish: () => record.remove(),
  };
}
