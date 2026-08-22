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
  [key: string]: unknown;
};

export type AskCompletion = {
  type: "response.completed";
  request_id: string;
  operation_id: string;
  conversation_id: string;
  knowledge_base_id: string;
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
  knowledge_base_id: string;
  empty: { is_empty: boolean; reason: string | null; threshold: number };
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
