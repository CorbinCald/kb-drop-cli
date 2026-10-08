import { createHash, randomUUID } from "node:crypto";
import type { OAuthCredential } from "../types.js";

/**
 * An in-memory kbDrop management API and object store, served through
 * `fetchImpl`. It follows the documented `/v1` contract closely enough to drive
 * the CLI end to end, and records every request for assertions.
 */

export const API_URL = "https://kbdrop.test";
export const STORAGE_URL = "https://storage.kbdrop.test";
export const MANAGEMENT_KEY = `kb_mgmt_${"m".repeat(12)}_${"k".repeat(43)}`;
/** Planted in every error message; the CLI must never print server text. */
export const SERVER_TEXT_CANARY = "server-text-canary";

type Failure = { stage: string; recovery: string; message: string };

type Job = {
  id: string;
  knowledgeBaseId: string;
  status: string;
  attempt: number;
  version: number;
  sourceType: string;
  /** Statuses the job moves through, one per status poll. */
  script: string[];
  failure: Failure | null;
  files: { discovered: number; processed: number; skipped: number; failed: number };
  uploadId: string | null;
  /** The review a paused job waits on, as the API serializes it. */
  review?: Record<string, unknown> | null;
};

type KnowledgeBaseRecord = {
  id: string;
  name: string;
  source: Record<string, unknown> & { type: string };
  activeVersion: number | null;
  latestJobId: string;
};

type UploadRecord = {
  id: string;
  knowledgeBaseId: string;
  jobId: string;
  status: string;
  filename: string;
  sizeBytes: number;
  fingerprint: string | null;
  partSize: number;
  partCount: number;
  confirmed: Map<number, { etag: string; size: number }>;
};

export type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
};

export type PutFault = Response | Error | undefined;

export function apiError(
  status: number,
  code: string,
  recovery: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    {
      error: {
        code,
        message: `${SERVER_TEXT_CANARY}: ${code}`,
        retryable: recovery === "wait" || recovery === "retry_later",
        recovery,
      },
    },
    { status, headers },
  );
}

function etagFor(bytes: Buffer): string {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class FakeKbDrop {
  readonly requests: RecordedRequest[] = [];
  readonly storagePuts: Array<{ uploadId: string; partNumber: number; size: number }> = [];
  readonly knowledgeBases = new Map<string, KnowledgeBaseRecord>();
  readonly jobs = new Map<string, Job>();
  readonly uploads = new Map<string, UploadRecord>();
  private readonly storedParts = new Map<string, Map<number, Buffer>>();
  private readonly idempotency = new Map<string, { request: string; knowledgeBaseId: string }>();
  private readonly crawlKeys = new Map<string, string>();
  private signatures = 0;
  private readonly expiredSignatures = new Set<string>();
  private putAttempts = new Map<number, number>();
  private inFlightPuts = 0;
  maxInFlightPuts = 0;

  /** Bytes per part; tiny so a small file needs several parts. */
  partSize = 4;
  maxPartsPerRequest = 8;
  /** Credentials the fake accepts, with the scopes each carries. */
  credentials = new Map<string, Set<string>>([
    [MANAGEMENT_KEY, new Set(["knowledge_bases:read", "knowledge_bases:write"])],
  ]);
  /** Statuses a job moves through after its source is in place. */
  jobScript: string[] = ["parsing", "embedding", "ready"];
  /** The poll interval a running job advertises. */
  pollAfterSeconds = 5;
  /** The time OAuth access tokens are checked against; tests share the CLI's clock. */
  now: () => number = Date.now;
  /** How long access tokens issued by a refresh last. */
  accessTokenSeconds = 900;
  /** Refresh grants answered: "issued", or "replayed" when a used token revoked the login. */
  readonly refreshGrants: Array<"issued" | "replayed" | "invalid"> = [];
  private readonly accessTokens = new Map<string, { scopes: Set<string>; expiresAt: number }>();
  private readonly refreshTokens = new Map<string, { scope: string; email: string; used: boolean }>();
  private issuedTokens = 0;
  jobFailure: Failure = {
    stage: "parsing",
    recovery: "retry",
    message: "The parser stopped unexpectedly.",
  };
  /** The review a job reaching "reviewing" in its script waits on. */
  review: Record<string, unknown> = {
    paused_at: "2026-09-24T12:00:00.000Z",
    exports: [
      {
        key: "slack.workspace.0123456789abcdef",
        app: "slack",
        record_unit: "conversation_day",
        reasons: ["private"],
        records: 12,
        private: {
          kinds: [{ kind: "direct_message", count: 2 }],
          records: 3,
          available: true,
        },
        link_base: null,
        too_large: null,
        partitions: [{ id: "00112233445566aa", label: "#incidents", records: 9, bytes: 2048 }],
      },
    ],
  };
  /** Answers to a review that are applied but lost on the way back. */
  lostReviewResponses = 0;
  /** Replays of a create answer 202 this many times while the upload is being opened. */
  initializingReplies = 0;
  /** Creates this many knowledge bases but loses the response, as a dropped connection does. */
  lostCreateResponses = 0;
  /** Retries this many jobs but loses the response. */
  lostRetryResponses = 0;
  readonly resumeReceipts = new Set<string>();
  /** Complete replies 202 this many times while storage assembles the parts. */
  completingReplies = 0;
  /** Parts storage discards once while assembling the upload, as a rejected part is. */
  rejectOnComplete: number[] = [];
  /** Decides the fate of each storage PUT: a response, a thrown error, or success. */
  onPut: (partNumber: number, attempt: number) => PutFault = () => undefined;
  /** Fails the create request itself, e.g. with a quota error. */
  onCreate: () => Response | undefined = () => undefined;
  /**
   * Intercepts any API request: a response to send instead, an error to throw
   * as a dropped connection does, or nothing to answer it normally.
   */
  onRequest: (request: {
    method: string;
    path: string;
    signal: AbortSignal | null;
  }) => Response | Error | Promise<Response> | undefined = () => undefined;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (url.origin === STORAGE_URL) {
      this.requests.push({
        method,
        url: url.toString(),
        authorization: headers.get("authorization"),
        body: undefined,
      });
      return this.put(url, init);
    }
    if (url.origin === API_URL && url.pathname === "/oauth/token") {
      return this.token(new URLSearchParams(String(init?.body ?? "")));
    }
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    this.requests.push({
      method,
      url: url.toString(),
      authorization: headers.get("authorization"),
      body,
    });
    if (url.origin !== API_URL) throw new TypeError("fetch failed");
    const intercepted = this.onRequest({
      method,
      path: url.pathname,
      signal: init?.signal ?? null,
    });
    if (intercepted instanceof Error) throw intercepted;
    if (intercepted) return intercepted;
    return this.route(method, url, headers, body);
  };

  /** Requests that reached the management API (not storage). */
  apiRequests(path?: RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        request.url.startsWith(API_URL) &&
        (!path || path.test(new URL(request.url).pathname)),
    );
  }

  storedBytes(uploadId: string): Buffer {
    const parts = this.storedParts.get(uploadId) ?? new Map<number, Buffer>();
    return Buffer.concat(
      [...parts.entries()].sort(([a], [b]) => a - b).map(([, bytes]) => bytes),
    );
  }

  /** Makes every signed URL issued so far answer 403, like an expired signature. */
  expireSignatures(): void {
    for (let signature = 1; signature <= this.signatures; signature += 1) {
      this.expiredSignatures.add(String(signature));
    }
  }

  /**
   * Issues the tokens `auth login --manage` saves. Each refresh token works
   * once; presenting a used one revokes the whole login, as kbDrop does.
   */
  savedLogin(input: { scope: string; expiresInSeconds: number }): OAuthCredential {
    const token = this.issueTokens(input.scope, "owner@example.com", input.expiresInSeconds);
    return {
      version: 1,
      apiUrl: API_URL,
      accessToken: token.access_token,
      accessExpiresAt: new Date(this.now() + token.expires_in * 1_000).toISOString(),
      refreshToken: token.refresh_token,
      scope: token.scope,
      account: token.account,
    };
  }

  private issueTokens(scope: string, email: string, expiresInSeconds: number) {
    this.issuedTokens += 1;
    const serial = String(this.issuedTokens).padStart(12, "0");
    const accessToken = `kb_oauth_at_${serial}_${"a".repeat(43)}`;
    const refreshToken = `kb_oauth_rt_${serial}_${"r".repeat(43)}`;
    this.accessTokens.set(accessToken, {
      scopes: new Set(scope.split(" ")),
      expiresAt: this.now() + expiresInSeconds * 1_000,
    });
    this.refreshTokens.set(refreshToken, { scope, email, used: false });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresInSeconds,
      refresh_token: refreshToken,
      scope,
      account: { email },
    };
  }

  private async token(form: URLSearchParams): Promise<Response> {
    // A refresh takes a network round trip, so concurrent callers overlap it.
    await yieldToEventLoop();
    const grant =
      form.get("grant_type") === "refresh_token"
        ? this.refreshTokens.get(form.get("refresh_token") ?? "")
        : undefined;
    if (!grant) {
      this.refreshGrants.push("invalid");
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (grant.used) {
      this.refreshGrants.push("replayed");
      this.accessTokens.clear();
      this.refreshTokens.clear();
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    grant.used = true;
    this.refreshGrants.push("issued");
    return Response.json(this.issueTokens(grant.scope, grant.email, this.accessTokenSeconds));
  }

  /** Closes an upload, as the idle sweeper does after an abandoned client. */
  abortUpload(uploadId: string): void {
    const upload = this.uploads.get(uploadId)!;
    upload.status = "aborted";
    const job = this.jobs.get(upload.jobId)!;
    job.status = "failed";
    job.failure = { stage: "upload", recovery: "replace_archive", message: "The upload expired." };
  }

  addKnowledgeBase(input: {
    name: string;
    source: Record<string, unknown> & { type: string };
    status: string;
    activeVersion?: number | null;
    failure?: Failure;
  }): { knowledgeBaseId: string; jobId: string } {
    const knowledgeBaseId = randomUUID();
    const job = this.newJob(knowledgeBaseId, input.source.type, 1, input.status);
    job.failure = input.status === "failed" ? (input.failure ?? this.jobFailure) : null;
    this.knowledgeBases.set(knowledgeBaseId, {
      id: knowledgeBaseId,
      name: input.name,
      source: input.source,
      activeVersion: input.activeVersion ?? (input.status === "ready" ? 1 : null),
      latestJobId: job.id,
    });
    return { knowledgeBaseId, jobId: job.id };
  }

  private newJob(
    knowledgeBaseId: string,
    sourceType: string,
    version: number,
    status: string,
  ): Job {
    const job: Job = {
      id: randomUUID(),
      knowledgeBaseId,
      status,
      attempt: 1,
      version,
      sourceType,
      script: [],
      failure: null,
      files: { discovered: 0, processed: 0, skipped: 0, failed: 0 },
      uploadId: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private authorize(headers: Headers, scope: string): Response | null {
    const token = headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
    const login = this.accessTokens.get(token);
    if (login && login.expiresAt <= this.now()) return apiError(401, "invalid_token", "authenticate");
    const scopes = this.credentials.get(token) ?? login?.scopes;
    if (!scopes) return apiError(401, "invalid_management_credential", "authenticate");
    if (!scopes.has(scope)) {
      return apiError(403, "management_key_scope_insufficient", "request_scope");
    }
    return null;
  }

  private serializeUpload(upload: UploadRecord) {
    const open = ["pending", "initiating", "uploading"].includes(upload.status);
    const missing: number[] = [];
    for (let part = 1; part <= upload.partCount; part += 1) {
      if (!upload.confirmed.has(part)) missing.push(part);
    }
    return {
      object: "upload",
      id: upload.id,
      knowledge_base_id: upload.knowledgeBaseId,
      ingestion_job_id: upload.jobId,
      status: upload.status,
      filename: upload.filename,
      size_bytes: upload.sizeBytes,
      fingerprint: upload.fingerprint,
      part_size_bytes: upload.partSize,
      part_count: upload.partCount,
      max_parts_per_request: this.maxPartsPerRequest,
      missing_part_numbers: open ? missing : [],
      idle_timeout_seconds: 3600,
      links: { self: `${API_URL}/v1/uploads/${upload.id}` },
    };
  }

  private serializeJob(job: Job) {
    const upload = job.uploadId ? this.uploads.get(job.uploadId)! : null;
    const knowledgeBase = this.knowledgeBases.get(job.knowledgeBaseId)!;
    const terminal = ["ready", "failed", "cancelled"].includes(job.status);
    let nextAction = "wait";
    let poll: number | null = this.pollAfterSeconds;
    if (job.status === "ready" || job.status === "cancelled") {
      nextAction = "none";
      poll = null;
    } else if (job.status === "failed") {
      const recovery = job.failure?.recovery;
      nextAction =
        recovery === "retry"
          ? "retry"
          : recovery === "replace_archive"
            ? "create_new_knowledge_base"
            : "contact_support";
      poll = null;
    } else if (job.status === "reviewing") {
      nextAction = "review";
      poll = null;
    } else if (job.status === "paused") {
      nextAction = "retry";
      poll = null;
    } else if (job.status === "uploading") {
      if (upload?.status === "uploading") {
        nextAction = upload.confirmed.size < upload.partCount ? "upload_parts" : "complete_upload";
        poll = null;
      } else poll = 2;
    }
    const confirmedBytes = upload
      ? [...upload.confirmed.values()].reduce((total, part) => total + part.size, 0)
      : 0;
    return {
      object: "ingestion_job",
      id: job.id,
      knowledge_base_id: job.knowledgeBaseId,
      status: job.status,
      terminal,
      attempt: job.attempt,
      source_type: job.sourceType,
      version: job.version,
      active_version: knowledgeBase.activeVersion,
      queryable: this.queryable(knowledgeBase),
      progress: {
        files: { ...job.files },
        upload: upload
          ? {
              parts_total: upload.partCount,
              parts_confirmed: upload.confirmed.size,
              bytes_total: upload.sizeBytes,
              bytes_confirmed: confirmedBytes,
            }
          : null,
        crawl:
          job.sourceType === "web"
            ? {
                pages_discovered: job.files.discovered,
                pages_fetched: job.files.processed,
                pages_indexed: job.files.processed,
                pages_skipped: 0,
                pages_failed: 0,
              }
            : null,
      },
      failure:
        job.status === "failed" && job.failure
          ? { ...job.failure, retryable: job.failure.recovery === "retry" }
          : null,
      next_action: nextAction,
      poll_after_seconds: poll,
      review: job.status === "reviewing" ? (job.review ?? this.review) : null,
      links: { self: `${API_URL}/v1/ingestion-jobs/${job.id}` },
    };
  }

  private queryable(knowledgeBase: KnowledgeBaseRecord): boolean {
    return knowledgeBase.activeVersion !== null;
  }

  private serializeKnowledgeBase(knowledgeBase: KnowledgeBaseRecord) {
    const latest = this.jobs.get(knowledgeBase.latestJobId)!;
    const status =
      knowledgeBase.activeVersion !== null && latest.status !== "ready" ? "ready" : latest.status;
    return {
      object: "knowledge_base",
      id: knowledgeBase.id,
      name: knowledgeBase.name,
      status,
      queryable: this.queryable(knowledgeBase),
      source: knowledgeBase.source,
      active_version: knowledgeBase.activeVersion,
      latest_job: { id: latest.id, status: latest.status, version: latest.version },
      links: { self: `${API_URL}/v1/knowledge-bases/${knowledgeBase.id}` },
    };
  }

  private creationPayload(knowledgeBaseId: string) {
    const knowledgeBase = this.knowledgeBases.get(knowledgeBaseId)!;
    const job = this.jobs.get(knowledgeBase.latestJobId)!;
    const upload = job.uploadId ? this.uploads.get(job.uploadId)! : null;
    return {
      knowledge_base: this.serializeKnowledgeBase(knowledgeBase),
      ingestion_job: this.serializeJob(job),
      upload: upload ? this.serializeUpload(upload) : null,
    };
  }

  private advance(job: Job): void {
    // A paused upload waits for its owner, however often it is polled.
    if (job.status === "reviewing" || job.status === "paused") return;
    const next = job.script.shift();
    if (!next) return;
    job.status = next;
    if (job.files.discovered === 0) job.files.discovered = 3;
    if (next !== "failed") {
      job.files.processed = Math.min(job.files.discovered, job.files.processed + 1);
    }
    if (next === "ready") {
      job.files.processed = job.files.discovered;
      this.knowledgeBases.get(job.knowledgeBaseId)!.activeVersion = job.version;
    }
    if (next === "failed") job.failure = { ...this.jobFailure };
  }

  private create(headers: Headers, body: Record<string, unknown>): Response {
    const denied = this.authorize(headers, "knowledge_bases:write");
    if (denied) return denied;
    const refused = this.onCreate();
    if (refused) return refused;
    const key = String(body.idempotency_key);
    const request = JSON.stringify({ name: body.name, source: body.source });
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.request !== request) {
        return apiError(409, "idempotency_mismatch", "use_new_idempotency_key");
      }
      const payload = this.creationPayload(existing.knowledgeBaseId);
      if (payload.upload && ["failed", "aborted"].includes(payload.upload.status)) {
        return apiError(409, "upload_unavailable", "create_new_knowledge_base");
      }
      if (this.initializingReplies > 0) {
        this.initializingReplies -= 1;
        return Response.json(payload, { status: 202, headers: { "Retry-After": "1" } });
      }
      const upload = payload.upload ? this.uploads.get(payload.upload.id)! : null;
      if (upload?.status === "initiating") upload.status = "uploading";
      return Response.json(this.creationPayload(existing.knowledgeBaseId), {
        headers: { "X-Idempotent-Replay": "true" },
      });
    }

    const source = body.source as Record<string, unknown> & { type: string };
    const knowledgeBaseId = randomUUID();
    const job = this.newJob(knowledgeBaseId, source.type, 1, "queued");
    const name =
      typeof body.name === "string"
        ? body.name
        : source.type === "upload"
          ? String(source.filename)
          : new URL(String(source.url)).hostname;
    let storedSource: Record<string, unknown> & { type: string } = source;
    if (source.type === "upload") {
      const sizeBytes = Number(source.size_bytes);
      const upload: UploadRecord = {
        id: randomUUID(),
        knowledgeBaseId,
        jobId: job.id,
        status: this.lostCreateResponses > 0 ? "initiating" : "uploading",
        filename: String(source.filename),
        sizeBytes,
        fingerprint: typeof source.fingerprint === "string" ? source.fingerprint : null,
        partSize: this.partSize,
        partCount: Math.ceil(sizeBytes / this.partSize),
        confirmed: new Map(),
      };
      this.uploads.set(upload.id, upload);
      job.uploadId = upload.id;
      job.status = "uploading";
      storedSource = {
        type: "upload",
        filename: upload.filename,
        input_kind: "archive",
        content_type: "application/zip",
        size_bytes: sizeBytes,
      };
    } else {
      job.script = [...(source.type === "web" ? ["crawling"] : []), ...this.jobScript];
    }
    this.knowledgeBases.set(knowledgeBaseId, {
      id: knowledgeBaseId,
      name,
      source: storedSource,
      activeVersion: null,
      latestJobId: job.id,
    });
    this.idempotency.set(key, { request, knowledgeBaseId });
    if (this.lostCreateResponses > 0) {
      this.lostCreateResponses -= 1;
      throw new TypeError("fetch failed");
    }
    return Response.json(this.creationPayload(knowledgeBaseId), {
      status: 201,
      headers: { Location: `${API_URL}/v1/knowledge-bases/${knowledgeBaseId}` },
    });
  }

  private async put(url: URL, init: RequestInit | undefined): Promise<Response> {
    const [, uploadId, partText] = url.pathname.split("/");
    const partNumber = Number(partText);
    const attempt = (this.putAttempts.get(partNumber) ?? 0) + 1;
    this.putAttempts.set(partNumber, attempt);
    this.inFlightPuts += 1;
    this.maxInFlightPuts = Math.max(this.maxInFlightPuts, this.inFlightPuts);
    try {
      await yieldToEventLoop();
      const fault = this.onPut(partNumber, attempt);
      if (fault instanceof Error) throw fault;
      if (fault) return fault;
      if (this.expiredSignatures.has(url.searchParams.get("signature") ?? "")) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      }
      const upload = this.uploads.get(uploadId!);
      if (!upload || upload.status === "aborted") {
        return new Response("<Error><Code>NoSuchUpload</Code></Error>", { status: 404 });
      }
      const bytes = Buffer.from(await new Response(init?.body).arrayBuffer());
      const parts = this.storedParts.get(uploadId!) ?? new Map<number, Buffer>();
      parts.set(partNumber, bytes);
      this.storedParts.set(uploadId!, parts);
      this.storagePuts.push({ uploadId: uploadId!, partNumber, size: bytes.length });
      return new Response(null, { status: 200, headers: { ETag: etagFor(bytes) } });
    } finally {
      this.inFlightPuts -= 1;
    }
  }

  private route(method: string, url: URL, headers: Headers, body: unknown): Response {
    const path = url.pathname;
    const input = (body ?? {}) as Record<string, unknown>;
    if (method === "POST" && path === "/v1/knowledge-bases") return this.create(headers, input);

    if (method === "GET" && path === "/v1/knowledge-bases") {
      const denied = this.authorize(headers, "knowledge_bases:read");
      if (denied) return denied;
      const all = [...this.knowledgeBases.values()];
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const page = all.slice(offset, offset + limit);
      const more = offset + limit < all.length;
      return Response.json({
        object: "list",
        data: page.map((knowledgeBase) => this.serializeKnowledgeBase(knowledgeBase)),
        has_more: more,
        next_cursor: more ? String(offset + limit) : null,
      });
    }

    let match = /^\/v1\/knowledge-bases\/([^/]+)$/u.exec(path);
    if (method === "GET" && match) {
      const denied = this.authorize(headers, "knowledge_bases:read");
      if (denied) return denied;
      const knowledgeBase = this.knowledgeBases.get(match[1]!);
      if (!knowledgeBase) return apiError(404, "knowledge_base_not_found", "check_identifier");
      return Response.json(this.serializeKnowledgeBase(knowledgeBase));
    }

    match = /^\/v1\/knowledge-bases\/([^/]+)\/crawls$/u.exec(path);
    if (method === "POST" && match) {
      const denied = this.authorize(headers, "knowledge_bases:write");
      if (denied) return denied;
      const knowledgeBase = this.knowledgeBases.get(match[1]!);
      if (!knowledgeBase) return apiError(404, "knowledge_base_not_found", "check_identifier");
      if (knowledgeBase.source.type !== "web") {
        return apiError(409, "knowledge_base_not_crawlable", "fix_request");
      }
      const key = String(input.idempotency_key);
      const replayed = this.crawlKeys.get(key);
      if (replayed) {
        return Response.json(
          {
            knowledge_base: this.serializeKnowledgeBase(knowledgeBase),
            ingestion_job: this.serializeJob(this.jobs.get(replayed)!),
          },
          { headers: { "X-Idempotent-Replay": "true" } },
        );
      }
      const latest = this.jobs.get(knowledgeBase.latestJobId)!;
      if (!["ready", "failed", "cancelled"].includes(latest.status)) {
        return apiError(409, "crawl_already_active", "wait", { "Retry-After": "5" });
      }
      const job = this.newJob(knowledgeBase.id, "web", latest.version + 1, "queued");
      job.script = ["crawling", ...this.jobScript];
      knowledgeBase.latestJobId = job.id;
      this.crawlKeys.set(key, job.id);
      return Response.json(
        {
          knowledge_base: this.serializeKnowledgeBase(knowledgeBase),
          ingestion_job: this.serializeJob(job),
        },
        { status: 202 },
      );
    }

    match = /^\/v1\/ingestion-jobs\/([^/]+)$/u.exec(path);
    if (method === "GET" && match) {
      const denied = this.authorize(headers, "knowledge_bases:read");
      if (denied) return denied;
      const job = this.jobs.get(match[1]!);
      if (!job) return apiError(404, "ingestion_job_not_found", "check_identifier");
      this.advance(job);
      return Response.json(this.serializeJob(job));
    }

    match = /^\/v1\/ingestion-jobs\/([^/]+)\/retry$/u.exec(path);
    if (method === "POST" && match) {
      const denied = this.authorize(headers, "knowledge_bases:write");
      if (denied) return denied;
      const job = this.jobs.get(match[1]!);
      if (!job) return apiError(404, "ingestion_job_not_found", "check_identifier");
      // As on the server: only the latest job retries, and naming an attempt
      // that was already retried replays that retry, however it has gone since.
      if (this.knowledgeBases.get(job.knowledgeBaseId)!.latestJobId !== job.id) {
        return apiError(409, "ingestion_job_superseded", "fix_request");
      }
      const attempt = Number(input.attempt);
      if (job.attempt > attempt) {
        return Response.json(this.serializeJob(job), {
          headers: { "X-Idempotent-Replay": "true" },
        });
      }
      if (job.attempt < attempt) {
        return apiError(409, "ingestion_attempt_mismatch", "fix_request");
      }
      const receipt = `${job.id}:${attempt}:${String(input.resume_key)}`;
      if (input.resume_key) {
        if (this.resumeReceipts.has(receipt)) {
          return Response.json(this.serializeJob(job), {
            headers: { "X-Idempotent-Replay": "true" },
          });
        }
        if (job.status !== "paused") return apiError(409, "ingestion_not_paused", "fix_request");
      }
      if (job.status === "paused") {
        if (!input.resume_key) return apiError(400, "resume_key_required", "fix_request");
        this.resumeReceipts.add(receipt);
        job.status = "crawling";
      } else {
        if (job.status !== "failed" || job.failure?.recovery !== "retry") {
          return apiError(409, "ingestion_not_retryable", "create_new_knowledge_base");
        }
        job.attempt += 1;
        job.status = "queued";
      }
      job.failure = null;
      job.script = [...this.jobScript];
      if (this.lostRetryResponses > 0) {
        this.lostRetryResponses -= 1;
        throw new TypeError("fetch failed");
      }
      return Response.json(this.serializeJob(job), { status: 202 });
    }

    match = /^\/v1\/ingestion-jobs\/([^/]+)\/review$/u.exec(path);
    if (method === "POST" && match) {
      const denied = this.authorize(headers, "knowledge_bases:write");
      if (denied) return denied;
      const job = this.jobs.get(match[1]!);
      if (!job) return apiError(404, "ingestion_job_not_found", "check_identifier");
      if (job.status !== "reviewing") return apiError(409, "review_not_pending", "fix_request");
      job.review = null;
      if (input.decision === "cancel") {
        job.status = "cancelled";
        job.script = [];
        return Response.json(this.serializeJob(job));
      }
      job.status = "queued";
      if (this.lostReviewResponses > 0) {
        this.lostReviewResponses -= 1;
        throw new TypeError("fetch failed");
      }
      return Response.json(this.serializeJob(job), { status: 202 });
    }

    match = /^\/v1\/uploads\/([^/]+)(\/[a-z-]+)?$/u.exec(path);
    if (match) {
      const upload = this.uploads.get(match[1]!);
      const action = match[2] ?? "";
      const scope = method === "GET" ? "knowledge_bases:read" : "knowledge_bases:write";
      const denied = this.authorize(headers, scope);
      if (denied) return denied;
      if (!upload) return apiError(404, "upload_not_found", "check_identifier");
      if (method === "GET" && action === "") return Response.json(this.serializeUpload(upload));
      if (method === "POST" && action === "/part-urls") return this.signParts(upload, input);
      if (method === "POST" && action === "/parts") return this.confirmParts(upload, input);
      if (method === "POST" && action === "/complete") return this.complete(upload);
    }
    return apiError(404, "not_found", "check_identifier");
  }

  private signParts(upload: UploadRecord, input: Record<string, unknown>): Response {
    if (upload.status !== "uploading") return apiError(409, "upload_not_active", "fix_request");
    const requested = Array.isArray(input.part_numbers)
      ? (input.part_numbers as number[])
      : this.serializeUpload(upload).missing_part_numbers.slice(0, this.maxPartsPerRequest);
    if (requested.length > this.maxPartsPerRequest) {
      return apiError(400, "invalid_request", "fix_request");
    }
    return Response.json({
      part_urls: requested.map((partNumber) => {
        this.signatures += 1;
        const start = (partNumber - 1) * upload.partSize;
        return {
          part_number: partNumber,
          size_bytes: Math.min(upload.partSize, upload.sizeBytes - start),
          method: "PUT",
          url: `${STORAGE_URL}/${upload.id}/${partNumber}?signature=${this.signatures}`,
          expires_at: "2026-09-24T12:15:00.000Z",
        };
      }),
    });
  }

  private confirmParts(upload: UploadRecord, input: Record<string, unknown>): Response {
    if (upload.status !== "uploading") return apiError(409, "upload_not_active", "fix_request");
    const stored = this.storedParts.get(upload.id) ?? new Map<number, Buffer>();
    for (const part of input.parts as Array<{ part_number: number; etag: string; size_bytes: number }>) {
      const bytes = stored.get(part.part_number);
      if (!bytes || etagFor(bytes) !== part.etag || bytes.length !== part.size_bytes) {
        return apiError(409, "upload_parts_rejected", "upload_missing_parts");
      }
      upload.confirmed.set(part.part_number, { etag: part.etag, size: part.size_bytes });
    }
    return Response.json(this.serializeUpload(upload));
  }

  private complete(upload: UploadRecord): Response {
    const job = this.jobs.get(upload.jobId)!;
    if (upload.status === "completed") {
      return Response.json(
        { upload: this.serializeUpload(upload), ingestion_job: this.serializeJob(job) },
        { headers: { "X-Idempotent-Replay": "true" } },
      );
    }
    if (upload.confirmed.size < upload.partCount) {
      return apiError(409, "parts_incomplete", "upload_missing_parts");
    }
    if (this.rejectOnComplete.length > 0) {
      const stored = this.storedParts.get(upload.id);
      for (const partNumber of this.rejectOnComplete) {
        upload.confirmed.delete(partNumber);
        stored?.delete(partNumber);
      }
      this.rejectOnComplete = [];
      return apiError(409, "upload_parts_rejected", "upload_missing_parts");
    }
    if (this.completingReplies > 0) {
      this.completingReplies -= 1;
      upload.status = "completing";
      return Response.json(
        { upload: this.serializeUpload(upload), ingestion_job: this.serializeJob(job) },
        { status: 202, headers: { "Retry-After": "2" } },
      );
    }
    upload.status = "completed";
    job.status = "queued";
    job.script = [...this.jobScript];
    return Response.json({
      upload: this.serializeUpload(upload),
      ingestion_job: this.serializeJob(job),
    });
  }
}
