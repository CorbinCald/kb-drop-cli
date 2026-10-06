export type OAuthCredential = {
  version: 1;
  apiUrl: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string | null;
  scope: string;
  account: { email: string };
};

export type Citation = {
  id: string;
  source_id: string;
  display_title: string;
  modality: string;
  source_url: string | null;
  deep_link: string | null;
  locator: Record<string, unknown>;
  locator_text: string;
  excerpt?: string;
  /** Present when an interface answered. */
  knowledge_base?: KnowledgeBaseLabel;
  [key: string]: unknown;
};

export type KnowledgeBaseLabel = { id: string; name: string };

export type AskCompletion = {
  type: "response.completed";
  request_id: string;
  operation_id: string;
  conversation_id: string;
  /** Null when an interface answered from several knowledge bases. */
  knowledge_base_id: string | null;
  interface_id?: string;
  knowledge_base_ids?: string[];
  answer_model: string | null;
  citations: Citation[];
  insufficient_evidence: boolean;
  answer?: string;
  output?: {
    type: "json";
    value: unknown;
    claims: Array<{ pointer: string; citation_ids: string[] }>;
  };
  usage?: Record<string, unknown> | null;
  latency?: Record<string, unknown> | null;
};

export type SearchResponse = {
  request_id: string;
  operation_id: string;
  knowledge_base_id: string | null;
  interface_id?: string;
  knowledge_base_ids?: string[];
  empty: { is_empty: boolean; reason: string | null; threshold: number | null };
  results: Array<{
    id: string;
    score: number;
    chunk: { id: string; content: string; token_count: number };
    source: {
      id: string;
      filename: string;
      relative_path: string;
      language: string | null;
    };
    symbol: { name: string | null; kind: string | null };
    location: { start_line: number | null; end_line: number | null };
    /** Present when an interface searched. */
    knowledge_base?: KnowledgeBaseLabel;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type OAuthMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  device_authorization_endpoint: string;
};

export type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
  account: { email: string };
};

export type IngestionFailure = {
  stage: string;
  recovery: string;
  retryable: boolean;
  message: string;
};

export type IngestionJob = {
  object: "ingestion_job";
  id: string;
  knowledge_base_id: string;
  status: string;
  terminal: boolean;
  attempt: number;
  source_type: string;
  version: number;
  active_version: number | null;
  queryable: boolean;
  progress: {
    files: { discovered: number; processed: number; skipped: number; failed: number };
    upload: {
      parts_total: number;
      parts_confirmed: number;
      bytes_total: number;
      bytes_confirmed: number;
    } | null;
    crawl: {
      pages_discovered: number;
      pages_fetched: number;
      pages_indexed: number;
      pages_skipped: number;
      pages_failed: number;
    } | null;
  };
  failure: IngestionFailure | null;
  next_action: string;
  poll_after_seconds: number | null;
  links: Record<string, string>;
  [key: string]: unknown;
};

export type KnowledgeBase = {
  object: "knowledge_base";
  id: string;
  name: string;
  status: string;
  queryable: boolean;
  source: { type: string; [key: string]: unknown };
  active_version: number | null;
  latest_job: { id: string; status: string; version: number };
  links: Record<string, string>;
  [key: string]: unknown;
};

export type Upload = {
  object: "upload";
  id: string;
  knowledge_base_id: string;
  ingestion_job_id: string;
  status: string;
  size_bytes: number;
  part_size_bytes: number;
  part_count: number;
  max_parts_per_request: number;
  missing_part_numbers: number[];
  [key: string]: unknown;
};

export type SignedPart = {
  part_number: number;
  size_bytes: number;
  url: string;
};

export type KnowledgeBaseList = {
  object: "list";
  data: KnowledgeBase[];
  has_more: boolean;
  next_cursor: string | null;
};
