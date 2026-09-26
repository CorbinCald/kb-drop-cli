import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseArguments } from "./args.js";
import type { CredentialStore } from "./credentials.js";
import { runCli } from "./main.js";
import { browserLogin, deviceLogin } from "./oauth.js";
import type { OAuthCredential } from "./types.js";

const apiUrl = "https://kbdrop.io";
const knowledgeBaseId = "30000000-0000-4000-8000-000000000001";
const apiKey = `kb_live_${"a".repeat(12)}_${"b".repeat(43)}`;
const accessToken = `kb_oauth_at_${"c".repeat(12)}_${"d".repeat(43)}`;
const refreshToken = `kb_oauth_rt_${"e".repeat(12)}_${"f".repeat(43)}`;
const authorizationCode = `kb_oauth_ac_${"g".repeat(12)}_${"h".repeat(43)}`;
const deviceCode = `kb_oauth_dc_${"i".repeat(12)}_${"j".repeat(43)}`;

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

  async backendName(): Promise<string> {
    return "Memory test store";
  }
}

function capture(): { stream: PassThrough; value: () => string } {
  const stream = new PassThrough();
  let value = "";
  stream.on("data", (chunk) => {
    value += chunk.toString();
  });
  return { stream, value: () => value };
}

function completion() {
  return {
    type: "response.completed",
    request_id: "10000000-0000-4000-8000-000000000001",
    operation_id: "10000000-0000-4000-8000-000000000001",
    conversation_id: "20000000-0000-4000-8000-000000000001",
    knowledge_base_id: knowledgeBaseId,
    answer_model: "google/gemini-3.5-flash-lite",
    answer: "Hold reset for ten seconds. [S1]",
    citations: [],
    insufficient_evidence: false,
  } as const;
}

describe("@kbdrop/cli", () => {
  it("rejects command-line secrets before parsing any command", () => {
    expect(() => parseArguments(["ask", "--api-key", "secret"])).toThrowError(
      expect.objectContaining({
        code: "secret_argument_forbidden",
      }),
    );
  });

  it("prefers KB_DROP_API_KEY and preserves one idempotency key across retries", async () => {
    const store = new MemoryStore();
    const bodies: string[] = [];
    const accepts: string[] = [];
    let calls = 0;
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli(
      [
        "ask",
        "How do I reset it?",
        "--kb",
        knowledgeBaseId,
        "--json",
        "--retries",
        "1",
      ],
      {
        store,
        environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
        stdout: stdout.stream,
        stderr: stderr.stream,
        sleep: async () => undefined,
        fetchImpl: async (_input, init) => {
          calls += 1;
          bodies.push(String(init?.body));
          accepts.push(new Headers(init?.headers).get("accept") ?? "");
          return calls === 1
            ? Response.json(
                { error: { code: "busy", message: "Busy" } },
                { status: 503, headers: { "Retry-After": "0" } },
              )
            : Response.json(completion());
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(store.reads).toBe(0);
    expect(calls).toBe(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0]!)).toMatchObject({
      input: "How do I reset it?",
      stream: false,
    });
    expect(JSON.parse(bodies[0]!).idempotency_key).toMatch(
      /^[0-9a-f-]{36}$/u,
    );
    expect(accepts).toEqual(["application/json", "application/json"]);
    expect(JSON.parse(stdout.value())).toMatchObject({
      schema_version: "1",
      ok: true,
      command: "ask",
      data: { answer: "Hold reset for ten seconds. [S1]" },
    });
    expect(stderr.value()).toBe("");
  });

  it("survives a connection reset, honors Retry-After, and keeps one logical ask", async () => {
    const bodies: string[] = [];
    const waits: number[] = [];
    let calls = 0;
    const stdout = capture();
    const exitCode = await runCli(
      [
        "ask",
        "--input",
        "transport fixture",
        "--knowledge-base",
        knowledgeBaseId,
        "--json",
        "--retries",
        "2",
      ],
      {
        store: new MemoryStore(),
        stdout: stdout.stream,
        stderr: capture().stream,
        environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
        fetchImpl: async (_input, init) => {
          calls += 1;
          bodies.push(String(init?.body));
          if (calls === 1) throw new TypeError("simulated connection reset");
          if (calls === 2) {
            return Response.json(
              { error: { code: "rate_limited", message: "private body" } },
              { status: 429, headers: { "Retry-After": "2" } },
            );
          }
          return Response.json(completion());
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(calls).toBe(3);
    expect(new Set(bodies)).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).idempotency_key).toMatch(/^[0-9a-f-]{36}$/u);
    expect(waits[0]).toBeGreaterThanOrEqual(250);
    expect(waits[0]).toBeLessThan(350);
    expect(waits[1]).toBe(2_000);
    expect(JSON.parse(stdout.value())).toMatchObject({ ok: true });
  });

  it("reads stdin and emits structured errors only on stderr", async () => {
    const stdout = capture();
    const stderr = capture();
    const stdin = Readable.from(["piped question\n"]) as Readable & {
      isTTY?: boolean;
    };
    stdin.isTTY = false;
    const exitCode = await runCli(
      ["ask", "--input", "-", "--kb", knowledgeBaseId, "--json"],
      {
        store: new MemoryStore(),
        stdin,
        stdout: stdout.stream,
        stderr: stderr.stream,
        environment: { NODE_ENV: "test" },
      },
    );
    expect(exitCode).toBe(3);
    expect(stdout.value()).toBe("");
    expect(JSON.parse(stderr.value())).toEqual({
      schema_version: "1",
      ok: false,
      error: {
        code: "login_required",
        message: "Run `kb-drop auth login` or set KB_DROP_API_KEY.",
      },
    });
  });

  it("reads a sensitive question from a file without printing its path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kb-drop-cli-test-"));
    const path = join(directory, "private-question.txt");
    const question = "question loaded from a private file";
    await writeFile(path, `${question}\n`, "utf8");
    const stdout = capture();
    const stderr = capture();
    try {
      const exitCode = await runCli(
        [
          "ask",
          "--input-file",
          path,
          "--knowledge-base",
          knowledgeBaseId,
          "--json",
        ],
        {
          store: new MemoryStore(),
          stdout: stdout.stream,
          stderr: stderr.stream,
          environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
          fetchImpl: async (_input, init) => {
            expect(JSON.parse(String(init?.body))).toMatchObject({ input: question });
            return Response.json(completion());
          },
        },
      );
      expect(exitCode).toBe(0);
      expect(`${stdout.value()}${stderr.value()}`).not.toContain(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects conflicting --query and --input sources for search", async () => {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli(
      [
        "search",
        "--knowledge-base",
        knowledgeBaseId,
        "--query",
        "Where is quota enforced?",
        "--input",
        "Where is quota enforced?",
        "--json",
      ],
      {
        store: new MemoryStore(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
        fetchImpl: async () => {
          throw new Error("must not reach the network");
        },
      },
    );
    expect(exitCode).toBe(2);
    expect(stdout.value()).toBe("");
    expect(JSON.parse(stderr.value())).toMatchObject({
      ok: false,
      error: { code: "input_conflict" },
    });
  });

  it("rejects extra auth arguments instead of silently ignoring them", async () => {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runCli(["auth", "status", "unexpected", "--json"], {
      store: new MemoryStore(),
      stdout: stdout.stream,
      stderr: stderr.stream,
      environment: { NODE_ENV: "test" },
    });
    expect(exitCode).toBe(2);
    expect(stdout.value()).toBe("");
    expect(JSON.parse(stderr.value())).toMatchObject({
      ok: false,
      error: { code: "unexpected_argument" },
    });
  });

  it("completes browser PKCE login through a verified loopback callback", async () => {
    const store = new MemoryStore();
    const stderr = capture();
    let challenge = "";
    let redirectUri = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: apiUrl,
          authorization_endpoint: `${apiUrl}/oauth/authorize`,
          token_endpoint: `${apiUrl}/oauth/token`,
          revocation_endpoint: `${apiUrl}/oauth/revoke`,
          device_authorization_endpoint: `${apiUrl}/oauth/device/code`,
        });
      }
      if (url === `${apiUrl}/oauth/token`) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("redirect_uri")).toBe(redirectUri);
        expect(
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(challenge);
        expect(form.get("code")).toBe(authorizationCode);
        return Response.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: refreshToken,
          scope: "knowledge:read knowledge:query offline_access",
          account: { email: "agent@example.com" },
        });
      }
      throw new Error("Unexpected OAuth request");
    };
    const saved = await browserLogin(
      apiUrl,
      {
        store,
        fetchImpl,
        stderr: stderr.stream,
        now: () => Date.parse("2026-08-22T12:00:00.000Z"),
        openUrl: async (value) => {
          const authorization = new URL(value);
          challenge = authorization.searchParams.get("code_challenge") ?? "";
          redirectUri = authorization.searchParams.get("redirect_uri") ?? "";
          expect(authorization.searchParams.get("code_challenge_method")).toBe(
            "S256",
          );
          expect(new URL(redirectUri).hostname).toBe("127.0.0.1");
          const callback = new URL(redirectUri);
          callback.searchParams.set("code", authorizationCode);
          callback.searchParams.set("state", "forged-state");
          callback.searchParams.set("iss", apiUrl);
          const forged = await fetch(callback, { redirect: "manual" });
          expect(forged.status).toBe(400);
          expect(forged.headers.get("location")).toBeNull();
          callback.searchParams.set(
            "state",
            authorization.searchParams.get("state") ?? "",
          );
          const verified = await fetch(callback, { redirect: "manual" });
          expect(verified.status).toBe(303);
          expect(verified.headers.get("location")).toBe(
            `${apiUrl}/cli/connected`,
          );
          expect(verified.headers.get("referrer-policy")).toBe("no-referrer");
        },
      },
      { openBrowser: true, timeoutMs: 30_000 },
    );
    expect(saved).toMatchObject({
      apiUrl,
      account: { email: "agent@example.com" },
      refreshToken,
      accessExpiresAt: "2026-08-22T12:15:00.000Z",
    });
    expect(store.value).toEqual(saved);
    expect(stderr.value()).toContain("Open this URL to authorize kbDrop CLI:");
    expect(stderr.value()).not.toContain(accessToken);
    expect(stderr.value()).not.toContain(refreshToken);
  });

  it.each([
    ["a denied", { error: "access_denied" }, "access_denied"],
    ["a codeless", {}, "authorization_code_missing"],
  ] as const)("sends %s browser login to kbDrop's not-connected page", async (
    _outcome,
    parameters: Record<string, string>,
    code,
  ) => {
    const store = new MemoryStore();
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: apiUrl,
          authorization_endpoint: `${apiUrl}/oauth/authorize`,
          token_endpoint: `${apiUrl}/oauth/token`,
          revocation_endpoint: `${apiUrl}/oauth/revoke`,
          device_authorization_endpoint: `${apiUrl}/oauth/device/code`,
        });
      }
      throw new Error("Unexpected OAuth request");
    };
    let denial = null as Promise<Response> | null;
    await expect(
      browserLogin(
        apiUrl,
        {
          store,
          fetchImpl,
          stderr: capture().stream,
          openUrl: async (value) => {
            const authorization = new URL(value);
            const callback = new URL(
              authorization.searchParams.get("redirect_uri") ?? "",
            );
            for (const [name, value] of Object.entries(parameters)) {
              callback.searchParams.set(name, value);
            }
            callback.searchParams.set(
              "state",
              authorization.searchParams.get("state") ?? "",
            );
            callback.searchParams.set("iss", apiUrl);
            // Like a real launcher, return while the browser is under way.
            denial = fetch(callback, { redirect: "manual" });
          },
        },
        { openBrowser: true, timeoutMs: 30_000 },
      ),
    ).rejects.toMatchObject({ kind: "auth", code });
    const response = await denial!;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${apiUrl}/cli/not-connected`);
    expect(store.value).toBeNull();
  });

  it("handles device pending, slow-down, and approval without printing tokens", async () => {
    const store = new MemoryStore();
    const stderr = capture();
    let clock = Date.parse("2026-08-22T13:00:00.000Z");
    let polls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/oauth-authorization-server")) {
        return Response.json({
          issuer: apiUrl,
          authorization_endpoint: `${apiUrl}/oauth/authorize`,
          token_endpoint: `${apiUrl}/oauth/token`,
          revocation_endpoint: `${apiUrl}/oauth/revoke`,
          device_authorization_endpoint: `${apiUrl}/oauth/device/code`,
        });
      }
      if (url.endsWith("/oauth/device/code")) {
        return Response.json({
          device_code: deviceCode,
          user_code: "ABCD-EFGH",
          verification_uri: `${apiUrl}/oauth/device`,
          verification_uri_complete: `${apiUrl}/oauth/device?user_code=ABCD-EFGH`,
          expires_in: 120,
          interval: 5,
        });
      }
      if (url.endsWith("/oauth/token")) {
        polls += 1;
        if (polls === 1) {
          return Response.json(
            { error: "authorization_pending", error_description: "secret detail" },
            { status: 400 },
          );
        }
        if (polls === 2) {
          return Response.json(
            { error: "slow_down", error_description: "secret detail" },
            { status: 400 },
          );
        }
        return Response.json({
          access_token: accessToken,
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: refreshToken,
          scope: "knowledge:read knowledge:query offline_access",
          account: { email: "device@example.com" },
        });
      }
      throw new Error("Unexpected device request");
    };
    const opened: string[] = [];
    const result = await deviceLogin(
      apiUrl,
      {
        store,
        fetchImpl,
        stderr: stderr.stream,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        openUrl: async (url) => {
          opened.push(url);
        },
      },
      { openBrowser: true },
    );
    expect(polls).toBe(3);
    expect(opened).toEqual([`${apiUrl}/oauth/device?user_code=ABCD-EFGH`]);
    expect(result.account.email).toBe("device@example.com");
    expect(store.value).toEqual(result);
    expect(stderr.value()).toContain("ABCD-EFGH");
    expect(stderr.value()).not.toContain(accessToken);
    expect(stderr.value()).not.toContain(refreshToken);
    expect(stderr.value()).not.toContain("secret detail");
  });

  it("handles device denial and local expiry with fixed, secret-safe errors", async () => {
    for (const outcome of ["access_denied", "expired"] as const) {
      const store = new MemoryStore();
      const stderr = capture();
      let clock = Date.parse("2026-08-22T14:00:00.000Z");
      let tokenPolls = 0;
      const fetchImpl: typeof fetch = async (input) => {
        const url = String(input);
        if (url.endsWith("/.well-known/oauth-authorization-server")) {
          return Response.json({
            issuer: apiUrl,
            authorization_endpoint: `${apiUrl}/oauth/authorize`,
            token_endpoint: `${apiUrl}/oauth/token`,
            revocation_endpoint: `${apiUrl}/oauth/revoke`,
            device_authorization_endpoint: `${apiUrl}/oauth/device/code`,
          });
        }
        if (url.endsWith("/oauth/device/code")) {
          return Response.json({
            device_code: deviceCode,
            user_code: "ABCD-EFGH",
            verification_uri: `${apiUrl}/oauth/device`,
            verification_uri_complete: `${apiUrl}/oauth/device?user_code=ABCD-EFGH`,
            expires_in: outcome === "expired" ? 5 : 120,
            interval: 5,
          });
        }
        if (url.endsWith("/oauth/token")) {
          tokenPolls += 1;
          return Response.json(
            {
              error: "access_denied",
              error_description: `${accessToken} private denial`,
            },
            { status: 400 },
          );
        }
        throw new Error("Unexpected device request");
      };
      await expect(
        deviceLogin(
          apiUrl,
          {
            store,
            fetchImpl,
            stderr: stderr.stream,
            now: () => clock,
            sleep: async (milliseconds) => {
              clock += milliseconds;
            },
          },
          { openBrowser: false },
        ),
      ).rejects.toMatchObject({
        code: outcome === "expired" ? "expired_token" : "access_denied",
      });
      expect(tokenPolls).toBe(outcome === "expired" ? 0 : 1);
      expect(stderr.value()).not.toContain(accessToken);
      expect(store.value).toBeNull();
    }
  });

  it("refreshes an expired login and revokes it during logout", async () => {
    const store = new MemoryStore();
    store.value = {
      version: 1,
      apiUrl,
      accessToken,
      accessExpiresAt: "2026-08-22T14:59:00.000Z",
      refreshToken,
      scope: "knowledge:read knowledge:query offline_access",
      account: { email: "agent@example.com" },
    };
    const rotatedAccess = `kb_oauth_at_${"k".repeat(12)}_${"l".repeat(43)}`;
    const rotatedRefresh = `kb_oauth_rt_${"m".repeat(12)}_${"n".repeat(43)}`;
    const requests: Array<{ url: string; form: URLSearchParams | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        form:
          init?.body instanceof URLSearchParams
            ? init.body
            : typeof init?.body === "string"
              ? new URLSearchParams(init.body)
              : null,
      });
      if (url.endsWith("/oauth/token")) {
        return Response.json({
          access_token: rotatedAccess,
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: rotatedRefresh,
          scope: "knowledge:read knowledge:query offline_access",
          account: { email: "agent@example.com" },
        });
      }
      if (url.includes("/messages")) return Response.json(completion());
      if (url.endsWith("/oauth/revoke")) return new Response(null);
      throw new Error("Unexpected request");
    };
    const askExit = await runCli(
      ["ask", "--input", "reset", "--kb", knowledgeBaseId, "--json"],
      {
        store,
        fetchImpl,
        stdout: capture().stream,
        stderr: capture().stream,
        now: () => Date.parse("2026-08-22T15:00:00.000Z"),
        environment: { NODE_ENV: "test" },
      },
    );
    expect(askExit).toBe(0);
    expect(store.value).toMatchObject({
      accessToken: rotatedAccess,
      refreshToken: rotatedRefresh,
    });

    const logoutOutput = capture();
    const logoutExit = await runCli(["auth", "logout", "--json"], {
      store,
      fetchImpl,
      stdout: logoutOutput.stream,
      stderr: capture().stream,
      environment: { NODE_ENV: "test" },
    });
    expect(logoutExit).toBe(0);
    expect(store.value).toBeNull();
    expect(
      requests.find(({ url }) => url.endsWith("/oauth/revoke"))?.form?.get("token"),
    ).toBe(rotatedRefresh);
    expect(logoutOutput.value()).not.toContain(rotatedAccess);
    expect(logoutOutput.value()).not.toContain(rotatedRefresh);
  });

  it("returns a distinct insufficient-evidence exit code after valid JSON output", async () => {
    const stdout = capture();
    const exitCode = await runCli(
      ["ask", "--input", "unknown", "--knowledge-base", knowledgeBaseId, "--json"],
      {
        store: new MemoryStore(),
        stdout: stdout.stream,
        stderr: capture().stream,
        environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
        fetchImpl: async () =>
          Response.json({ ...completion(), answer: "I don’t have enough evidence.", insufficient_evidence: true }),
      },
    );
    expect(exitCode).toBe(8);
    expect(JSON.parse(stdout.value())).toMatchObject({
      ok: true,
      data: { insufficient_evidence: true },
    });
  });

  it("keeps the stable JSON envelope across buffered and SSE compatibility paths", async () => {
    const outputs: unknown[] = [];
    for (const stream of [false, true]) {
      const stdout = capture();
      const exitCode = await runCli(
        [
          "ask",
          "--input",
          "reset",
          "--knowledge-base",
          knowledgeBaseId,
          "--json",
          ...(stream ? ["--stream-compat"] : []),
        ],
        {
          store: new MemoryStore(),
          stdout: stdout.stream,
          stderr: capture().stream,
          environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
          fetchImpl: async () =>
            stream
              ? new Response(
                  `event: response.completed\ndata: ${JSON.stringify(completion())}\n\n`,
                )
              : Response.json(completion()),
        },
      );
      expect(exitCode).toBe(0);
      outputs.push(JSON.parse(stdout.value()));
    }
    expect(outputs[1]).toEqual(outputs[0]);
  });

  it("renders search results for people and as stable JSON", async () => {
    const response = {
      request_id: "10000000-0000-4000-8000-000000000002",
      operation_id: "10000000-0000-4000-8000-000000000002",
      knowledge_base_id: knowledgeBaseId,
      empty: { is_empty: false, reason: null, threshold: 0.4 },
      results: [
        {
          id: "result-1",
          score: 0.91,
          chunk: { id: "chunk-1", content: "Quota is checked here.", token_count: 5 },
          source: {
            id: "source-1",
            filename: "quota.ts",
            relative_path: "src/quota.ts",
            language: "typescript",
          },
          symbol: { name: "reserveQuota", kind: "function" },
          location: { start_line: 41, end_line: 44 },
        },
      ],
    };
    for (const json of [false, true]) {
      const stdout = capture();
      const exitCode = await runCli(
        [
          "search",
          "--knowledge-base",
          knowledgeBaseId,
          "--query",
          "Where is quota enforced?",
          ...(json ? ["--json"] : []),
        ],
        {
          store: new MemoryStore(),
          stdout: stdout.stream,
          stderr: capture().stream,
          environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
          fetchImpl: async () => Response.json(response),
        },
      );
      expect(exitCode).toBe(0);
      if (json) {
        expect(JSON.parse(stdout.value())).toMatchObject({
          schema_version: "1",
          command: "search",
          data: { results: [{ score: 0.91 }] },
        });
      } else {
        expect(stdout.value()).toContain("src/quota.ts:41-44 (0.910)");
      }
    }
  });

  it("never echoes server bodies, prompts, credentials, signed URLs, or input paths", async () => {
    const stdout = capture();
    const stderr = capture();
    const question = "private launch question";
    const localPath = "/private/operator/question.txt";
    const signedUrl = "https://storage.example/private?X-Amz-Signature=secret";
    const exitCode = await runCli(
      ["ask", "--input", question, "--knowledge-base", knowledgeBaseId, "--json"],
      {
        store: new MemoryStore(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
        fetchImpl: async () =>
          Response.json(
            {
              error: {
                code: `${apiKey}_${question}`,
                message: `${question} ${apiKey} ${signedUrl} ${localPath}`,
              },
            },
            { status: 400 },
          ),
      },
    );
    const rendered = `${stdout.value()}${stderr.value()}`;
    expect(exitCode).toBe(4);
    expect(rendered).not.toContain(question);
    expect(rendered).not.toContain(apiKey);
    expect(rendered).not.toContain(signedUrl);
    expect(rendered).not.toContain(localPath);
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: { code: "http_400" },
    });
  });

  it("redacts terminal SSE error fields supplied by an untrusted response", async () => {
    const stdout = capture();
    const stderr = capture();
    const question = "private SSE question";
    const signedUrl = "https://storage.example/private?X-Amz-Signature=secret";
    const exitCode = await runCli(
      [
        "ask",
        "--input",
        question,
        "--knowledge-base",
        knowledgeBaseId,
        "--stream-compat",
        "--json",
        "--retries",
        "0",
      ],
      {
        store: new MemoryStore(),
        stdout: stdout.stream,
        stderr: stderr.stream,
        environment: { NODE_ENV: "test", KB_DROP_API_KEY: apiKey },
        fetchImpl: async () =>
          new Response(
            `data: ${JSON.stringify({
              type: "error",
              error: {
                code: `${apiKey}_${question}`,
                message: `${accessToken} ${signedUrl}`,
              },
            })}\n\n`,
          ),
      },
    );
    const rendered = `${stdout.value()}${stderr.value()}`;
    expect(exitCode).toBe(5);
    expect(rendered).not.toContain(apiKey);
    expect(rendered).not.toContain(question);
    expect(rendered).not.toContain(accessToken);
    expect(rendered).not.toContain(signedUrl);
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: {
        code: "answer_failed",
        message: "The answer stream failed before completion.",
      },
    });
  });

  it("rejects an invalid environment key in auth status", async () => {
    const stderr = capture();
    const exitCode = await runCli(["auth", "status", "--json"], {
      store: new MemoryStore(),
      stdout: capture().stream,
      stderr: stderr.stream,
      environment: { NODE_ENV: "test", KB_DROP_API_KEY: "not-a-key" },
    });
    expect(exitCode).toBe(3);
    expect(JSON.parse(stderr.value())).toMatchObject({
      error: { code: "api_key_invalid" },
    });
  });

  it("generates static shell completions without loading credentials", async () => {
    const stdout = capture();
    const exitCode = await runCli(["completion", "bash"], {
      stdout: stdout.stream,
      stderr: capture().stream,
      environment: { NODE_ENV: "test" },
      store: {
        get: async () => {
          throw new Error("must not read credentials");
        },
        set: async () => undefined,
        delete: async () => undefined,
      },
    });
    expect(exitCode).toBe(0);
    expect(stdout.value()).toContain("complete -F _kb_drop_complete kb-drop");
  });
});
