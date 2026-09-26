import { createHash } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { CliError } from "./errors.js";
import type { ConfirmedPart, ManagementClient } from "./management.js";
import type { IngestionJob, SignedPart, Upload } from "./types.js";

/** kbDrop's per-file ceiling; media types have smaller limits the server enforces. */
export const MAX_UPLOAD_BYTES = 1024 ** 3;
const FINGERPRINT_VERSION = "sha256-tree-v1";
const FINGERPRINT_CHUNK_BYTES = 16 * 1024 * 1024;
const PART_ATTEMPTS = 4;
const PART_TIMEOUT_MS = 10 * 60_000;
// Rounds of "upload what is missing, then complete" before giving up; storage
// rarely rejects a part, and never repeatedly for a healthy client.
const COMPLETION_ROUNDS = 3;
const COMPLETION_POLLS = 30;

export type LocalFile = {
  path: string;
  filename: string;
  sizeBytes: number;
  modifiedAtMs: number;
};

export type UploadProgress = {
  stage: "upload";
  upload_id: string;
  parts_total: number;
  parts_confirmed: number;
  bytes_total: number;
  bytes_confirmed: number;
};

type UploadDependencies = {
  client: ManagementClient;
  file: LocalFile;
  parallel: number;
  fetchImpl?: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  random?: () => number;
  onProgress: (progress: UploadProgress) => void;
  /**
   * Reads the upload's current state again with the knowledge_bases:write
   * scope that uploading needs, since the credential may not also carry
   * knowledge_bases:read.
   */
  reload: () => Promise<Upload>;
};

function fileChanged(): CliError {
  return new CliError(
    "usage",
    "file_changed",
    "The file changed while it was being uploaded. Run the command again once it is stable.",
  );
}

function unreadable(): CliError {
  return new CliError("usage", "file_unreadable", "The file could not be read.");
}

export async function inspectLocalFile(path: string): Promise<LocalFile> {
  const stats = await stat(path).catch(() => {
    throw unreadable();
  });
  if (!stats.isFile()) {
    throw new CliError("usage", "file_not_regular", "--file must name a regular file.");
  }
  if (stats.size === 0) throw new CliError("usage", "file_empty", "The file is empty.");
  if (stats.size > MAX_UPLOAD_BYTES) {
    throw new CliError("usage", "file_too_large", "Files may be at most 1 GiB.");
  }
  const filename = basename(path);
  if (filename.length > 255) {
    throw new CliError("usage", "filename_too_long", "The file name may be at most 255 characters.");
  }
  return { path, filename, sizeBytes: stats.size, modifiedAtMs: stats.mtimeMs };
}

async function assertUnchanged(file: LocalFile): Promise<void> {
  const stats = await stat(file.path).catch(() => {
    throw unreadable();
  });
  if (stats.size !== file.sizeBytes || stats.mtimeMs !== file.modifiedAtMs) {
    throw fileChanged();
  }
}

/**
 * The browser's resume fingerprint (`sha256-tree-v1`): SHA-256 over a header
 * and the digest of each 16 MiB chunk. The server keeps it with the upload and
 * rejects a replay whose file differs.
 */
export async function resumeFingerprint(
  file: Pick<LocalFile, "path" | "sizeBytes">,
  chunkBytes = FINGERPRINT_CHUNK_BYTES,
): Promise<string> {
  const digests: Buffer[] = [];
  let hash = createHash("sha256");
  let filled = 0;
  let total = 0;
  try {
    for await (const chunk of createReadStream(file.path, { highWaterMark: 1024 * 1024 })) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      for (let offset = 0; offset < bytes.length; ) {
        const take = Math.min(chunkBytes - filled, bytes.length - offset);
        hash.update(bytes.subarray(offset, offset + take));
        filled += take;
        offset += take;
        if (filled === chunkBytes) {
          digests.push(hash.digest());
          hash = createHash("sha256");
          filled = 0;
        }
      }
    }
  } catch {
    throw unreadable();
  }
  if (filled > 0) digests.push(hash.digest());
  if (total !== file.sizeBytes) throw fileChanged();
  const header = Buffer.from(`${FINGERPRINT_VERSION}\n${total}\n${digests.length}\n`);
  const manifest = createHash("sha256").update(Buffer.concat([header, ...digests]));
  return `${FINGERPRINT_VERSION}:${manifest.digest("hex")}`;
}

/** File bytes may go only to HTTPS storage, or plain HTTP on this machine. */
function storageUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("output", "unexpected_response", "The kbDrop API returned an invalid upload URL.");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError(
      "output",
      "storage_url_insecure",
      "The kbDrop API returned an upload URL that does not use HTTPS.",
    );
  }
  return url.toString();
}

function progress(upload: Upload): UploadProgress {
  const confirmed = upload.part_count - upload.missing_part_numbers.length;
  const lastPartBytes = upload.size_bytes - (upload.part_count - 1) * upload.part_size_bytes;
  const lastMissing = upload.missing_part_numbers.includes(upload.part_count);
  const bytesConfirmed =
    confirmed === 0
      ? 0
      : lastMissing
        ? confirmed * upload.part_size_bytes
        : (confirmed - 1) * upload.part_size_bytes + lastPartBytes;
  return {
    stage: "upload",
    upload_id: upload.id,
    parts_total: upload.part_count,
    parts_confirmed: confirmed,
    bytes_total: upload.size_bytes,
    bytes_confirmed: bytesConfirmed,
  };
}

/** PUTs one part straight to object storage, retrying and re-signing as needed. */
async function putPart(
  dependencies: UploadDependencies,
  upload: Upload,
  blob: Blob,
  part: SignedPart,
): Promise<ConfirmedPart> {
  const start = (part.part_number - 1) * upload.part_size_bytes;
  const end = start + part.size_bytes;
  if (part.part_number < 1 || part.size_bytes < 1 || end > blob.size) {
    throw new CliError("output", "unexpected_response", "The kbDrop API returned an invalid upload part.");
  }
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const random = dependencies.random ?? Math.random;
  let url = storageUrl(part.url);
  for (let attempt = 1; ; attempt += 1) {
    let status: number | null = null;
    try {
      const response = await fetchImpl(url, {
        method: "PUT",
        body: blob.slice(start, end),
        signal: AbortSignal.timeout(PART_TIMEOUT_MS),
      });
      status = response.status;
      const etag = response.headers.get("etag");
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        if (!etag) {
          throw new CliError(
            "output",
            "storage_etag_missing",
            "Object storage did not return an ETag for an uploaded part.",
          );
        }
        return { part_number: part.part_number, etag, size_bytes: part.size_bytes };
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      // A read failure here is usually the network, but may be the file
      // changing underneath the upload; the latter must not be retried.
      await assertUnchanged(dependencies.file);
    }
    if (status === 404) {
      throw new CliError(
        "request",
        "upload_closed",
        "Object storage no longer has this upload. Run the same command again to start over.",
      );
    }
    if (attempt >= PART_ATTEMPTS) {
      throw new CliError(
        "network",
        "storage_upload_failed",
        `Part ${part.part_number} could not be uploaded to object storage. Run the same command again to resume.`,
        status === null ? {} : { status },
      );
    }
    if (status === 403) {
      // An expired or refused signature: sign this part again.
      const [renewed] = await dependencies.client.signParts(upload.id, [part.part_number]);
      if (!renewed || renewed.part_number !== part.part_number) {
        throw new CliError("output", "unexpected_response", "The kbDrop API returned an invalid upload part.");
      }
      url = storageUrl(renewed.url);
    } else {
      await dependencies.sleep(
        Math.min(10_000, 1_000 * 2 ** (attempt - 1)) + Math.floor(random() * 250),
      );
    }
  }
}

/**
 * Uploads the parts the server still lists as missing, `parallel` at a time.
 * Each batch is confirmed as soon as it is stored, including the parts that
 * succeeded next to a failed one, so an interrupted run loses little work.
 */
async function uploadMissingParts(
  dependencies: UploadDependencies,
  initial: Upload,
): Promise<{ upload: Upload; partsUploaded: number }> {
  let blob: Blob;
  try {
    blob = await openAsBlob(dependencies.file.path);
  } catch {
    throw unreadable();
  }
  if (blob.size !== initial.size_bytes) throw fileChanged();
  // The resume fingerprint describes the file as it was inspected; refuse to
  // upload anything else under it.
  await assertUnchanged(dependencies.file);
  const batchSize = Math.max(
    1,
    Math.min(dependencies.parallel, initial.max_parts_per_request),
  );
  let upload = initial;
  let partsUploaded = 0;
  dependencies.onProgress(progress(upload));
  // Every round confirms at least one part or throws, so this bound is only a
  // guard against a server that stops recording parts.
  for (let round = 0; round <= initial.part_count; round += 1) {
    if (upload.status !== "uploading" || upload.missing_part_numbers.length === 0) {
      return { upload, partsUploaded };
    }
    const batch = upload.missing_part_numbers.slice(0, batchSize);
    const signed = await dependencies.client.signParts(upload.id, batch);
    if (
      signed.length !== batch.length ||
      !signed.every((part, index) => part.part_number === batch[index])
    ) {
      throw new CliError("output", "unexpected_response", "The kbDrop API signed different parts than requested.");
    }
    const current = upload;
    const outcomes = await Promise.allSettled(
      signed.map((part) => putPart(dependencies, current, blob, part)),
    );
    const stored = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    if (stored.length > 0) {
      upload = await dependencies.client.confirmParts(upload.id, stored);
      partsUploaded += stored.length;
      dependencies.onProgress(progress(upload));
    }
    const failed = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failed) throw failed.reason;
  }
  throw new CliError(
    "output",
    "upload_not_advancing",
    "The kbDrop API did not record the uploaded parts. Run the same command again to resume.",
  );
}

/**
 * Drives an open upload to a queued ingestion job: upload missing parts,
 * complete, and upload again if storage rejected a part during assembly.
 */
export async function finishUpload(
  dependencies: UploadDependencies,
  initial: Upload,
): Promise<{ upload: Upload; job: IngestionJob; partsUploaded: number }> {
  let upload = initial;
  let partsUploaded = 0;
  for (let round = 0; round < COMPLETION_ROUNDS; round += 1) {
    if (upload.status === "uploading" && upload.missing_part_numbers.length > 0) {
      const result = await uploadMissingParts(dependencies, upload);
      upload = result.upload;
      partsUploaded += result.partsUploaded;
    }
    let rejected = false;
    for (let poll = 0; poll < COMPLETION_POLLS && !rejected; poll += 1) {
      try {
        const completed = await dependencies.client.completeUpload(upload.id);
        upload = completed.upload;
        if (upload.status !== "completing") {
          return { upload, job: completed.job, partsUploaded };
        }
        // Another request is assembling this upload; wait for it.
        await dependencies.sleep((completed.retryAfterSeconds ?? 2) * 1_000);
      } catch (error) {
        if (
          error instanceof CliError &&
          (error.code === "parts_incomplete" || error.code === "upload_parts_rejected")
        ) {
          upload = await dependencies.reload();
          rejected = true;
        } else {
          throw error;
        }
      }
    }
    if (!rejected) break;
  }
  throw new CliError(
    "transient",
    "upload_not_completed",
    "The upload could not be completed. Run the same command again to resume.",
  );
}
