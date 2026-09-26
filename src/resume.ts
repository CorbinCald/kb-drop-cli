import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { UUID_PATTERN } from "./management.js";

const RECORD_VERSION = 1;
// Resume exists for interruptions. After a day the same command starts a new
// knowledge base instead of replaying an old one.
const RECORD_TTL_MS = 24 * 60 * 60 * 1_000;

type PendingRecord = {
  version: typeof RECORD_VERSION;
  idempotency_key: string;
  created_at: string;
};

export type PendingOperation = {
  idempotencyKey: string;
  /** An earlier, interrupted run of the same command left this key behind. */
  resumed: boolean;
  /** Replaces the key after the server reported the earlier attempt unusable. */
  restart(): Promise<string>;
  /** Forgets the key, so running the same command again starts a new operation. */
  finish(): Promise<void>;
};

/**
 * Where interrupted operations are remembered: KB_DROP_STATE_DIR, else the
 * platform's per-user state directory. Records hold an idempotency key and a
 * timestamp, never credentials, paths, or file contents.
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

function unavailable(): CliError {
  return new CliError(
    "usage",
    "state_directory_unavailable",
    "Resume state could not be saved. Set KB_DROP_STATE_DIR to a writable directory, or pass --idempotency-key.",
  );
}

function parseRecord(encoded: string, now: number): PendingRecord | null {
  try {
    const value = JSON.parse(encoded) as Partial<PendingRecord>;
    const createdAt = Date.parse(String(value.created_at));
    if (
      value.version === RECORD_VERSION &&
      typeof value.idempotency_key === "string" &&
      UUID_PATTERN.test(value.idempotency_key) &&
      Number.isFinite(createdAt) &&
      now - createdAt < RECORD_TTL_MS &&
      createdAt <= now + 60_000
    ) {
      return value as PendingRecord;
    }
  } catch {
    // A damaged record is replaced below.
  }
  return null;
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
  const directory = join(stateDirectory(input.environment), "pending-operations");
  const digest = createHash("sha256")
    .update(JSON.stringify({ api_url: input.apiUrl, request: input.request }))
    .digest("hex");
  const path = join(directory, `${digest}.json`);

  const save = async (idempotencyKey: string): Promise<void> => {
    const record: PendingRecord = {
      version: RECORD_VERSION,
      idempotency_key: idempotencyKey,
      created_at: new Date(input.now).toISOString(),
    };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw unavailable();
    }
  };

  let existing: PendingRecord | null = null;
  try {
    existing = parseRecord(await readFile(path, "utf8"), input.now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unavailable();
  }
  const pending: PendingOperation = {
    idempotencyKey: existing?.idempotency_key ?? randomUUID(),
    resumed: existing !== null,
    async restart() {
      pending.idempotencyKey = randomUUID();
      pending.resumed = false;
      await save(pending.idempotencyKey);
      return pending.idempotencyKey;
    },
    async finish() {
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
  if (!existing) await save(pending.idempotencyKey);
  return pending;
}
