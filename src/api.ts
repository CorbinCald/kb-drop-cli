import { randomUUID } from "node:crypto";
import { CliError } from "./errors.js";
import type { AskCompletion, SearchResponse } from "./types.js";

export type RetryOptions = {
  retries: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

export type AskOptions = {
  conversationId?: string;
  idempotencyKey?: string;
  stream?: boolean;
  citationDetail?: "compact" | "full";
  includeExcerpts?: boolean;
  includeUsage?: boolean;
  includeLatency?: boolean;
  maxAnswerTokens?: number;
  responseSchema?: unknown;
  onDelta?: (delta: string) => void;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function retryAfterMilliseconds(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function retryable(response: Response): boolean {
  return (
    response.status === 429 ||
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504 ||
    (response.status === 409 && response.headers.has("retry-after"))
  );
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const random = options.random ?? Math.random;
  let lastNetworkError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = init.signal
        ? AbortSignal.any([init.signal, timeout])
        : timeout;
      const response = await fetchImpl(url, { ...init, signal });
      if (!retryable(response) || attempt === options.retries) return response;
      const instructed = retryAfterMilliseconds(response.headers.get("retry-after"));
      const backoff = Math.min(
        30_000,
        instructed ?? 250 * 2 ** attempt + Math.floor(random() * 100),
      );
      await response.body?.cancel().catch(() => undefined);
      await sleep(backoff);
    } catch (error) {
      lastNetworkError = error;
      if (attempt === options.retries) break;
      await sleep(Math.min(5_000, 250 * 2 ** attempt + Math.floor(random() * 100)));
    }
  }
  if (lastNetworkError instanceof DOMException && lastNetworkError.name === "TimeoutError") {
    throw new CliError("network", "request_timed_out", "The request timed out.");
  }
  throw new CliError(
    "network",
    "network_unavailable",
    "The kbDrop API could not be reached.",
  );
}

function positiveRetryAfter(response: Response): number | undefined {
  const milliseconds = retryAfterMilliseconds(response.headers.get("retry-after"));
  return milliseconds === null ? undefined : Math.ceil(milliseconds / 1_000);
}

async function apiFailure(response: Response): Promise<CliError> {
  let code = `http_${response.status}`;
  const message =
    response.status === 401
      ? "Authentication failed. Log in again or check KB_DROP_API_KEY."
      : response.status === 403
        ? "This credential is not authorized for the requested operation."
        : response.status === 404
          ? "The requested kbDrop resource was not found."
          : response.status === 409
            ? "The request conflicts with the current operation state."
            : response.status === 429
              ? "The kbDrop API rate limit was reached."
              : response.status >= 500
                ? "The kbDrop service is temporarily unavailable."
                : "The kbDrop API rejected the request.";
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    if (
      typeof body.error?.code === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/u.test(body.error.code)
    ) {
      code = body.error.code;
    }
  } catch {
    // Generic status-based text is safer than echoing an unexpected body.
  }
  const kind =
    response.status === 401 || response.status === 403
      ? "auth"
      : response.status === 429 || response.status >= 500
        ? "transient"
        : "request";
  return new CliError(kind, code, message, {
    status: response.status,
    retryAfterSeconds: positiveRetryAfter(response),
    requestId: response.headers.get("x-request-id") ?? undefined,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCitation(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.locator)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.source_id === "string" &&
    typeof value.display_title === "string" &&
    typeof value.modality === "string" &&
    (typeof value.source_url === "string" || value.source_url === null) &&
    (typeof value.deep_link === "string" || value.deep_link === null) &&
    typeof value.locator_text === "string"
  );
}

function isStructuredOutput(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "json" || !Array.isArray(value.claims)) {
    return false;
  }
  return value.claims.every(
    (claim) =>
      isRecord(claim) &&
      typeof claim.pointer === "string" &&
      Array.isArray(claim.citation_ids) &&
      claim.citation_ids.every((id) => typeof id === "string"),
  );
}

function isAskCompletion(value: unknown): value is AskCompletion {
  if (!isRecord(value)) return false;
  const hasAnswer = typeof value.answer === "string";
  const hasOutput = isStructuredOutput(value.output);
  return (
    value.type === "response.completed" &&
    typeof value.request_id === "string" &&
    typeof value.operation_id === "string" &&
    typeof value.conversation_id === "string" &&
    typeof value.knowledge_base_id === "string" &&
    (typeof value.answer_model === "string" || value.answer_model === null) &&
    Array.isArray(value.citations) &&
    value.citations.every(isCitation) &&
    typeof value.insufficient_evidence === "boolean" &&
    hasAnswer !== hasOutput
  );
}

function safeEventErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "answer_failed";
}

async function parseSse(
  response: Response,
  onDelta?: (delta: string) => void,
): Promise<AskCompletion> {
  if (!response.body) {
    throw new CliError("output", "empty_response", "The answer stream was empty.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completion: AskCompletion | null = null;
  const consume = (block: string): void => {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new CliError(
        "output",
        "invalid_event_stream",
        "The kbDrop API returned an invalid event stream.",
      );
    }
    if (!event || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    if (record.type === "response.delta" && typeof record.delta === "string") {
      onDelta?.(record.delta);
    }
    if (record.type === "error") {
      const detail = record.error as Record<string, unknown> | undefined;
      throw new CliError(
        "transient",
        safeEventErrorCode(detail?.code),
        "The answer stream failed before completion.",
      );
    }
    if (isAskCompletion(record)) completion = record;
  };
  while (true) {
    const result = await reader.read();
    buffer += decoder.decode(result.value, { stream: !result.done });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() ?? "";
    blocks.forEach(consume);
    if (result.done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!completion) {
    throw new CliError(
      "output",
      "answer_incomplete",
      "The answer stream ended before completion.",
    );
  }
  return completion;
}

export class ApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly authorization: string,
    private readonly retry: RetryOptions,
  ) {}

  async ask(
    knowledgeBaseId: string,
    input: string,
    options: AskOptions = {},
  ): Promise<AskCompletion> {
    const stream = options.stream ?? false;
    const payload = {
      input,
      idempotency_key: options.idempotencyKey ?? randomUUID(),
      stream,
      ...(options.conversationId
        ? { conversation_id: options.conversationId }
        : {}),
      ...(options.citationDetail
        ? { citation_detail: options.citationDetail }
        : {}),
      ...(options.includeExcerpts !== undefined
        ? { include_excerpts: options.includeExcerpts }
        : {}),
      ...(options.includeUsage !== undefined
        ? { include_usage: options.includeUsage }
        : {}),
      ...(options.includeLatency !== undefined
        ? { include_latency: options.includeLatency }
        : {}),
      ...(options.maxAnswerTokens !== undefined
        ? { max_answer_tokens: options.maxAnswerTokens }
        : {}),
      ...(options.responseSchema !== undefined
        ? { response_schema: options.responseSchema }
        : {}),
    };
    const response = await fetchWithRetry(
      `${this.apiUrl}/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/messages`,
      {
        method: "POST",
        headers: {
          Accept: stream ? "text/event-stream" : "application/json",
          Authorization: this.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      this.retry,
    );
    if (!response.ok) throw await apiFailure(response);
    if (stream) return parseSse(response, options.onDelta);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CliError(
        "output",
        "invalid_json_response",
        "The kbDrop API returned invalid JSON.",
      );
    }
    if (!isAskCompletion(value)) {
      throw new CliError(
        "output",
        "unexpected_response",
        "The kbDrop API returned an unexpected answer shape.",
      );
    }
    return value;
  }

  async search(
    knowledgeBaseId: string,
    input: {
      query: string;
      topK: number;
      languages: string[];
      pathPrefix?: string;
    },
  ): Promise<SearchResponse> {
    const response = await fetchWithRetry(
      `${this.apiUrl}/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/search`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: this.authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          top_k: input.topK,
          ...(input.languages.length > 0 || input.pathPrefix
            ? {
                filters: {
                  ...(input.languages.length > 0
                    ? { languages: input.languages }
                    : {}),
                  ...(input.pathPrefix
                    ? { path_prefix: input.pathPrefix }
                    : {}),
                },
              }
            : {}),
        }),
      },
      this.retry,
    );
    if (!response.ok) throw await apiFailure(response);
    const value = (await response.json().catch(() => null)) as SearchResponse | null;
    if (!value || !Array.isArray(value.results) || typeof value.request_id !== "string") {
      throw new CliError(
        "output",
        "unexpected_response",
        "The kbDrop API returned an unexpected search shape.",
      );
    }
    return value;
  }
}
