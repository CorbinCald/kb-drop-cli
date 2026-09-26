import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import open from "open";
import type { Writable } from "node:stream";
import { CliError } from "./errors.js";
import type { CredentialStore } from "./credentials.js";
import type {
  OAuthCredential,
  OAuthMetadata,
  OAuthTokenResponse,
} from "./types.js";

const CLIENT_ID = "kb-drop-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "knowledge:read knowledge:query offline_access";
const API_KEY_PATTERN = /^kb_live_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;
const ACCESS_TOKEN_PATTERN =
  /^kb_oauth_at_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;
const REFRESH_TOKEN_PATTERN =
  /^kb_oauth_rt_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;
const AUTHORIZATION_CODE_PATTERN =
  /^kb_oauth_ac_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;
const DEVICE_CODE_PATTERN =
  /^kb_oauth_dc_[A-Za-z0-9_-]{12}_[A-Za-z0-9_-]{43}$/u;

type OAuthDependencies = {
  store: CredentialStore;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  stderr: Pick<Writable, "write">;
};

class OAuthEndpointError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function safeOAuthErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    access_denied: "Authorization was denied.",
    authorization_pending: "Authorization is still pending.",
    expired_token: "The authorization request expired.",
    invalid_client: "This CLI is not accepted by the authorization server.",
    invalid_grant: "The saved login is invalid or expired. Log in again.",
    invalid_request: "The OAuth request was rejected.",
    invalid_scope: "The requested OAuth scope is not supported.",
    slow_down: "The authorization server requested slower polling.",
    temporarily_unavailable: "The OAuth service is temporarily unavailable.",
    unauthorized_client: "This CLI is not authorized for that OAuth flow.",
    unsupported_grant_type: "The OAuth grant type is not supported.",
  };
  return messages[code] ?? "The OAuth request was rejected.";
}

function safeOAuthErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : "oauth_request_rejected";
}

function line(stream: Pick<Writable, "write">, value: string): void {
  stream.write(`${value}\n`);
}

export function environmentApiKey(
  environment: NodeJS.ProcessEnv,
): string | null {
  const apiKey = environment.KB_DROP_API_KEY?.trim();
  if (!apiKey) return null;
  if (!API_KEY_PATTERN.test(apiKey)) {
    throw new CliError(
      "auth",
      "api_key_invalid",
      "KB_DROP_API_KEY does not contain a valid kbDrop API key.",
    );
  }
  return apiKey;
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("usage", "invalid_api_url", "--api-url must be a valid URL.");
  }
  const local = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new CliError(
      "usage",
      "invalid_api_url",
      "--api-url must be an HTTPS origin (HTTP is allowed only for loopback development).",
    );
  }
  return url.origin;
}

function sameOriginEndpoint(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === new URL(origin).protocol
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export async function discoverOAuthMetadata(
  apiUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthMetadata> {
  let response: Response;
  try {
    response = await fetchImpl(
      `${apiUrl}/.well-known/oauth-authorization-server`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    throw new CliError(
      "network",
      "oauth_discovery_failed",
      "The kbDrop OAuth server could not be reached.",
    );
  }
  if (!response.ok) {
    throw new CliError(
      "transient",
      "oauth_discovery_failed",
      "The kbDrop OAuth server is unavailable.",
      { status: response.status },
    );
  }
  const value = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!value || value.issuer !== apiUrl) {
    throw new CliError(
      "auth",
      "oauth_metadata_invalid",
      "The kbDrop OAuth metadata could not be verified.",
    );
  }
  const metadata: OAuthMetadata = {
    issuer: apiUrl,
    authorization_endpoint:
      sameOriginEndpoint(value.authorization_endpoint, apiUrl) ?? "",
    token_endpoint: sameOriginEndpoint(value.token_endpoint, apiUrl) ?? "",
    revocation_endpoint:
      sameOriginEndpoint(value.revocation_endpoint, apiUrl) ?? "",
    device_authorization_endpoint:
      sameOriginEndpoint(value.device_authorization_endpoint, apiUrl) ?? "",
  };
  if (Object.values(metadata).some((entry) => !entry)) {
    throw new CliError(
      "auth",
      "oauth_metadata_invalid",
      "The kbDrop OAuth metadata could not be verified.",
    );
  }
  return metadata;
}

async function oauthPost(
  endpoint: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new CliError(
      "network",
      "oauth_request_failed",
      "The kbDrop OAuth server could not be reached.",
    );
  }
  const value = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || typeof value?.error === "string") {
    const code = safeOAuthErrorCode(
      typeof value?.error === "string" ? value.error : `http_${response.status}`,
    );
    throw new OAuthEndpointError(
      code,
      safeOAuthErrorMessage(code),
      response.status,
    );
  }
  return value;
}

function tokenResponse(value: unknown): OAuthTokenResponse {
  if (!value || typeof value !== "object") {
    throw new CliError("auth", "oauth_response_invalid", "The OAuth token response was invalid.");
  }
  const token = value as Record<string, unknown>;
  const account = token.account as Record<string, unknown> | undefined;
  if (
    typeof token.access_token !== "string" ||
    !ACCESS_TOKEN_PATTERN.test(token.access_token) ||
    token.token_type !== "Bearer" ||
    typeof token.expires_in !== "number" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0 ||
    (token.refresh_token !== undefined &&
      (typeof token.refresh_token !== "string" ||
        !REFRESH_TOKEN_PATTERN.test(token.refresh_token))) ||
    typeof token.scope !== "string" ||
    typeof account?.email !== "string"
  ) {
    throw new CliError("auth", "oauth_response_invalid", "The OAuth token response was invalid.");
  }
  return token as OAuthTokenResponse;
}

function credential(
  apiUrl: string,
  token: OAuthTokenResponse,
  now: number,
  previousRefreshToken?: string | null,
): OAuthCredential {
  return {
    version: 1,
    apiUrl,
    accessToken: token.access_token,
    accessExpiresAt: new Date(now + token.expires_in * 1_000).toISOString(),
    refreshToken: token.refresh_token ?? previousRefreshToken ?? null,
    scope: token.scope,
    account: token.account,
  };
}

function closeServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

// A verified callback ends on kbDrop's own result page, which carries the
// site's styling. It is same-origin with the consent page, so that page's CSP
// `form-action 'self'` allows this second redirect.
function showResultPage(
  response: ServerResponse,
  issuer: string,
  page: "connected" | "not-connected",
): void {
  response
    .writeHead(303, {
      Location: new URL(`/cli/${page}`, issuer).toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    .end();
}

async function loopbackCallback(input: {
  state: string;
  issuer: string;
  timeoutMs: number;
}): Promise<{
  redirectUri: string;
  receive: Promise<string>;
  close: () => void;
}> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const receive = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  let settled = false;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || !request.url) {
      response.writeHead(405).end("Method not allowed");
      return;
    }
    const callback = new URL(request.url, "http://127.0.0.1");
    if (callback.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (settled) {
      response.writeHead(409).end("Authorization already completed");
      return;
    }
    const state = callback.searchParams.get("state");
    const issuer = callback.searchParams.get("iss");
    const code = callback.searchParams.get("code");
    const oauthError = callback.searchParams.get("error");
    if (state !== input.state || issuer !== input.issuer) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Authorization verification failed. Return to your terminal.");
      return;
    }
    settled = true;
    if (oauthError) {
      const code = safeOAuthErrorCode(oauthError);
      showResultPage(response, input.issuer, "not-connected");
      rejectCode(new CliError("auth", code, safeOAuthErrorMessage(code)));
      return;
    }
    if (!code || !AUTHORIZATION_CODE_PATTERN.test(code)) {
      showResultPage(response, input.issuer, "not-connected");
      rejectCode(new CliError("auth", "authorization_code_missing", "The OAuth callback did not include an authorization code."));
      return;
    }
    showResultPage(response, input.issuer, "connected");
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }).catch(() => {
    throw new CliError(
      "network",
      "loopback_listener_failed",
      "The local OAuth callback listener could not be started.",
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    closeServer(server);
    throw new CliError("network", "loopback_listener_failed", "The local OAuth callback listener could not be started.");
  }
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectCode(new CliError("auth", "login_timed_out", "OAuth login timed out."));
    }
  }, input.timeoutMs);
  timer.unref();
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    receive: receive.finally(() => clearTimeout(timer)),
    close: () => closeServer(server),
  };
}

export async function browserLogin(
  apiUrl: string,
  dependencies: OAuthDependencies,
  options: { openBrowser: boolean; timeoutMs: number },
): Promise<OAuthCredential> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const metadata = await discoverOAuthMetadata(apiUrl, fetchImpl);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = await loopbackCallback({
    state,
    issuer: metadata.issuer,
    timeoutMs: options.timeoutMs,
  });
  try {
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: callback.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: SCOPE,
      state,
    }).toString();
    line(dependencies.stderr, `Open this URL to authorize kbDrop CLI:\n${authorization}`);
    if (options.openBrowser) {
      try {
        await (dependencies.openUrl ?? ((url) => open(url)))(authorization.toString());
      } catch {
        line(dependencies.stderr, "The browser could not be opened automatically; use the URL above.");
      }
    }
    const code = await callback.receive;
    const token = tokenResponse(
      await oauthPost(
        metadata.token_endpoint,
        {
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code,
          redirect_uri: callback.redirectUri,
          code_verifier: verifier,
        },
        fetchImpl,
      ),
    );
    const saved = credential(apiUrl, token, (dependencies.now ?? Date.now)());
    await dependencies.store.set(apiUrl, saved);
    return saved;
  } catch (error) {
    if (error instanceof OAuthEndpointError) {
      throw new CliError("auth", error.code, error.message, { status: error.status });
    }
    throw error;
  } finally {
    callback.close();
  }
}

type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

function deviceAuthorization(value: unknown, apiUrl: string): DeviceAuthorization {
  if (!value || typeof value !== "object") {
    throw new CliError("auth", "device_response_invalid", "The device login response was invalid.");
  }
  const result = value as Record<string, unknown>;
  const verification = sameOriginEndpoint(result.verification_uri, apiUrl);
  const complete = sameOriginEndpoint(result.verification_uri_complete, apiUrl);
  if (
    typeof result.device_code !== "string" ||
    !DEVICE_CODE_PATTERN.test(result.device_code) ||
    typeof result.user_code !== "string" ||
    !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(result.user_code) ||
    !verification ||
    !complete ||
    typeof result.expires_in !== "number" ||
    !Number.isInteger(result.expires_in) ||
    result.expires_in < 1 ||
    result.expires_in > 1_800 ||
    typeof result.interval !== "number" ||
    !Number.isInteger(result.interval) ||
    result.interval < 5 ||
    result.interval > 60
  ) {
    throw new CliError("auth", "device_response_invalid", "The device login response was invalid.");
  }
  return {
    device_code: result.device_code,
    user_code: result.user_code,
    verification_uri: verification,
    verification_uri_complete: complete,
    expires_in: result.expires_in,
    interval: result.interval,
  };
}

export async function deviceLogin(
  apiUrl: string,
  dependencies: OAuthDependencies,
  options: { openBrowser: boolean },
): Promise<OAuthCredential> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? Date.now;
  const metadata = await discoverOAuthMetadata(apiUrl, fetchImpl);
  let authorization: DeviceAuthorization;
  try {
    authorization = deviceAuthorization(
      await oauthPost(
        metadata.device_authorization_endpoint,
        { client_id: CLIENT_ID, scope: SCOPE },
        fetchImpl,
      ),
      apiUrl,
    );
  } catch (error) {
    if (error instanceof OAuthEndpointError) {
      throw new CliError("auth", error.code, error.message, { status: error.status });
    }
    throw error;
  }
  line(dependencies.stderr, `Enter code ${authorization.user_code} at ${authorization.verification_uri}`);
  if (options.openBrowser) {
    try {
      await (dependencies.openUrl ?? ((url) => open(url)))(
        authorization.verification_uri_complete,
      );
    } catch {
      line(dependencies.stderr, "The browser could not be opened automatically; use the URL above.");
    }
  }
  const deadline = now() + authorization.expires_in * 1_000;
  let intervalMs = Math.max(5_000, authorization.interval * 1_000);
  while (now() < deadline) {
    await sleep(intervalMs);
    if (now() >= deadline) break;
    try {
      const token = tokenResponse(
        await oauthPost(
          metadata.token_endpoint,
          {
            grant_type: DEVICE_GRANT_TYPE,
            client_id: CLIENT_ID,
            device_code: authorization.device_code,
          },
          fetchImpl,
        ),
      );
      const saved = credential(apiUrl, token, now());
      await dependencies.store.set(apiUrl, saved);
      return saved;
    } catch (error) {
      if (error instanceof OAuthEndpointError) {
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") {
          intervalMs += 5_000;
          continue;
        }
        throw new CliError("auth", error.code, error.message, { status: error.status });
      }
      throw error;
    }
  }
  throw new CliError("auth", "expired_token", "The device authorization expired.");
}

export async function authorizationForApi(
  apiUrl: string,
  dependencies: Pick<OAuthDependencies, "store" | "fetchImpl" | "now">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ authorization: string; source: "environment" | "oauth"; account?: string }> {
  const apiKey = environmentApiKey(environment);
  if (apiKey) {
    return { authorization: `Bearer ${apiKey}`, source: "environment" };
  }
  const stored = await dependencies.store.get(apiUrl);
  if (!stored) {
    throw new CliError(
      "auth",
      "login_required",
      "Run `kb-drop auth login` or set KB_DROP_API_KEY.",
    );
  }
  const now = (dependencies.now ?? Date.now)();
  if (Date.parse(stored.accessExpiresAt) > now + 30_000) {
    return {
      authorization: `Bearer ${stored.accessToken}`,
      source: "oauth",
      account: stored.account.email,
    };
  }
  if (!stored.refreshToken) {
    await dependencies.store.delete(apiUrl);
    throw new CliError(
      "auth",
      "login_expired",
      "The saved login expired. Run `kb-drop auth login` again.",
    );
  }
  try {
    const token = tokenResponse(
      await oauthPost(
        `${apiUrl}/oauth/token`,
        {
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: stored.refreshToken,
        },
        dependencies.fetchImpl ?? fetch,
      ),
    );
    const refreshed = credential(apiUrl, token, now, stored.refreshToken);
    await dependencies.store.set(apiUrl, refreshed);
    return {
      authorization: `Bearer ${refreshed.accessToken}`,
      source: "oauth",
      account: refreshed.account.email,
    };
  } catch (error) {
    if (error instanceof OAuthEndpointError) {
      if (["invalid_grant", "access_denied"].includes(error.code)) {
        await dependencies.store.delete(apiUrl);
      }
      throw new CliError("auth", error.code, error.message, { status: error.status });
    }
    throw error;
  }
}

export async function logout(
  apiUrl: string,
  dependencies: Pick<OAuthDependencies, "store" | "fetchImpl">,
): Promise<boolean> {
  const stored = await dependencies.store.get(apiUrl);
  if (!stored) return false;
  try {
    await oauthPost(
      `${apiUrl}/oauth/revoke`,
      {
        client_id: CLIENT_ID,
        token: stored.refreshToken ?? stored.accessToken,
      },
      dependencies.fetchImpl ?? fetch,
    ).catch(() => undefined);
  } finally {
    await dependencies.store.delete(apiUrl);
  }
  return true;
}
