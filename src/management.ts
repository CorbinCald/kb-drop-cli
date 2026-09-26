import { apiFailure, fetchWithRetry, type RetryOptions } from "./api.js";
import { CliError } from "./errors.js";
import type {
  IngestionJob,
  KnowledgeBase,
  KnowledgeBaseList,
  SignedPart,
  Upload,
} from "./types.js";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CreateKnowledgeBaseBody = {
  idempotency_key: string;
  name?: string;
  source: Record<string, unknown> & { type: "upload" | "web" | "video_url" };
};

export type CreatedKnowledgeBase = {
  /** 201 created, 200 replayed, or 202 while another request opens the upload. */
  status: number;
  retryAfterSeconds: number | null;
  knowledge_base: KnowledgeBase;
  ingestion_job: IngestionJob;
  upload: Upload | null;
};

export type ConfirmedPart = {
  part_number: number;
  etag: string;
  size_bytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isIngestionJob(value: unknown): value is IngestionJob {
  return (
    isRecord(value) &&
    value.object === "ingestion_job" &&
    isId(value.id) &&
    isId(value.knowledge_base_id) &&
    typeof value.status === "string" &&
    typeof value.terminal === "boolean" &&
    Number.isInteger(value.attempt) &&
    typeof value.queryable === "boolean" &&
    typeof value.next_action === "string" &&
    (value.poll_after_seconds === null ||
      typeof value.poll_after_seconds === "number") &&
    isRecord(value.progress) &&
    isRecord(value.links)
  );
}

export function isKnowledgeBase(value: unknown): value is KnowledgeBase {
  return (
    isRecord(value) &&
    value.object === "knowledge_base" &&
    isId(value.id) &&
    typeof value.name === "string" &&
    typeof value.status === "string" &&
    typeof value.queryable === "boolean" &&
    isRecord(value.source) &&
    isRecord(value.latest_job) &&
    isId(value.latest_job.id) &&
    isRecord(value.links)
  );
}

function isUpload(value: unknown): value is Upload {
  return (
    isRecord(value) &&
    value.object === "upload" &&
    isId(value.id) &&
    typeof value.status === "string" &&
    Number.isSafeInteger(value.size_bytes) &&
    Number.isSafeInteger(value.part_size_bytes) &&
    (value.part_size_bytes as number) > 0 &&
    Number.isSafeInteger(value.part_count) &&
    Number.isSafeInteger(value.max_parts_per_request) &&
    Array.isArray(value.missing_part_numbers) &&
    value.missing_part_numbers.every((part) => Number.isSafeInteger(part))
  );
}

function isSignedPart(value: unknown): value is SignedPart {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.part_number) &&
    Number.isSafeInteger(value.size_bytes) &&
    typeof value.url === "string"
  );
}

function unexpected(): CliError {
  return new CliError(
    "output",
    "unexpected_response",
    "The kbDrop API returned an unexpected response.",
  );
}

/**
 * The `/v1` management API. Every URL is built here from validated IDs rather
 * than followed from response links, so a response can never redirect the
 * credential to another origin.
 */
export class ManagementClient {
  /** `authorize` returns the current `Authorization` header value. */
  constructor(
    private readonly apiUrl: string,
    private readonly authorize: () => Promise<string>,
    private readonly retry: RetryOptions,
  ) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ response: Response; value: unknown }> {
    const send = (authorization: string) =>
      fetchWithRetry(
        `${this.apiUrl}${path}`,
        {
          method,
          headers: {
            Accept: "application/json",
            Authorization: authorization,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        this.retry,
      );
    const authorization = await this.authorize();
    let response = await send(authorization);
    if (response.status === 401) {
      // A token can expire while a request waits out retries. kbDrop refuses
      // an expired token before doing anything, so the request is sent again
      // once, and only when the login has since been refreshed.
      const renewed = await this.authorize();
      if (renewed !== authorization) {
        await response.body?.cancel().catch(() => undefined);
        response = await send(renewed);
      }
    }
    if (!response.ok) throw await apiFailure(response);
    const value: unknown = await response.json().catch(() => undefined);
    if (value === undefined) {
      throw new CliError(
        "output",
        "invalid_json_response",
        "The kbDrop API returned invalid JSON.",
      );
    }
    return { response, value };
  }

  async createKnowledgeBase(body: CreateKnowledgeBaseBody): Promise<CreatedKnowledgeBase> {
    const { response, value } = await this.request("POST", "/v1/knowledge-bases", body);
    if (
      !isRecord(value) ||
      !isKnowledgeBase(value.knowledge_base) ||
      !isIngestionJob(value.ingestion_job) ||
      !(value.upload === null || isUpload(value.upload))
    ) {
      throw unexpected();
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      knowledge_base: value.knowledge_base,
      ingestion_job: value.ingestion_job,
      upload: value.upload,
    };
  }

  async listKnowledgeBases(input: { limit: number; cursor?: string }): Promise<KnowledgeBaseList> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.cursor) query.set("cursor", input.cursor);
    const { value } = await this.request("GET", `/v1/knowledge-bases?${query}`);
    if (
      !isRecord(value) ||
      !Array.isArray(value.data) ||
      !value.data.every(isKnowledgeBase) ||
      typeof value.has_more !== "boolean" ||
      !(value.next_cursor === null || typeof value.next_cursor === "string")
    ) {
      throw unexpected();
    }
    return value as KnowledgeBaseList;
  }

  async getKnowledgeBase(id: string): Promise<KnowledgeBase> {
    const { value } = await this.request("GET", `/v1/knowledge-bases/${encodeURIComponent(id)}`);
    if (!isKnowledgeBase(value)) throw unexpected();
    return value;
  }

  async getIngestionJob(id: string): Promise<IngestionJob> {
    const { value } = await this.request("GET", `/v1/ingestion-jobs/${encodeURIComponent(id)}`);
    if (!isIngestionJob(value)) throw unexpected();
    return value;
  }

  /** Requeues the failed `attempt`; repeating it returns the same requeued job. */
  async retryIngestionJob(
    id: string,
    attempt: number,
  ): Promise<{ replayed: boolean; job: IngestionJob }> {
    const { response, value } = await this.request(
      "POST",
      `/v1/ingestion-jobs/${encodeURIComponent(id)}/retry`,
      { attempt },
    );
    if (!isIngestionJob(value)) throw unexpected();
    return {
      replayed: response.headers.get("x-idempotent-replay") === "true",
      job: value,
    };
  }

  /** Crawls a website knowledge base again; the key makes a repeat a replay. */
  async startCrawl(
    id: string,
    idempotencyKey: string,
  ): Promise<{ replayed: boolean; knowledge_base: KnowledgeBase; ingestion_job: IngestionJob }> {
    const { response, value } = await this.request(
      "POST",
      `/v1/knowledge-bases/${encodeURIComponent(id)}/crawls`,
      { idempotency_key: idempotencyKey },
    );
    if (
      !isRecord(value) ||
      !isKnowledgeBase(value.knowledge_base) ||
      !isIngestionJob(value.ingestion_job)
    ) {
      throw unexpected();
    }
    return {
      replayed: response.headers.get("x-idempotent-replay") === "true",
      knowledge_base: value.knowledge_base,
      ingestion_job: value.ingestion_job,
    };
  }

  async getUpload(id: string): Promise<Upload> {
    const { value } = await this.request("GET", `/v1/uploads/${encodeURIComponent(id)}`);
    if (!isUpload(value)) throw unexpected();
    return value;
  }

  async signParts(uploadId: string, partNumbers: number[]): Promise<SignedPart[]> {
    const { value } = await this.request(
      "POST",
      `/v1/uploads/${encodeURIComponent(uploadId)}/part-urls`,
      { part_numbers: partNumbers },
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value.part_urls) ||
      !value.part_urls.every(isSignedPart)
    ) {
      throw unexpected();
    }
    return value.part_urls;
  }

  async confirmParts(uploadId: string, parts: ConfirmedPart[]): Promise<Upload> {
    const { value } = await this.request(
      "POST",
      `/v1/uploads/${encodeURIComponent(uploadId)}/parts`,
      { parts },
    );
    if (!isUpload(value)) throw unexpected();
    return value;
  }

  async completeUpload(
    uploadId: string,
  ): Promise<{ status: number; upload: Upload; job: IngestionJob; retryAfterSeconds: number | null }> {
    const { response, value } = await this.request(
      "POST",
      `/v1/uploads/${encodeURIComponent(uploadId)}/complete`,
      {},
    );
    if (!isRecord(value) || !isUpload(value.upload) || !isIngestionJob(value.ingestion_job)) {
      throw unexpected();
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    return {
      status: response.status,
      upload: value.upload,
      job: value.ingestion_job,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    };
  }
}
