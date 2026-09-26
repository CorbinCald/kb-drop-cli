import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { ApiClient } from "./api.js";
import {
  ensureAllowed,
  hasOption,
  integerOption,
  option,
  options,
  parseArguments,
  type ParsedArguments,
} from "./args.js";
import {
  NativeCredentialStore,
  type CredentialStore,
} from "./credentials.js";
import {
  CliError,
  INSUFFICIENT_EVIDENCE_EXIT_CODE,
} from "./errors.js";
import {
  KNOWLEDGE_BASE_COMMANDS,
  runKnowledgeBaseCommand,
} from "./knowledge-bases.js";
import {
  authorizationForApi,
  browserLogin,
  deviceLogin,
  environmentApiKey,
  environmentManagementKey,
  grantsScope,
  logout,
  MANAGEMENT_SCOPE,
  normalizeApiUrl,
  QUERY_SCOPE,
} from "./oauth.js";
import {
  writeError,
  writeHumanAnswer,
  writeHumanSearch,
  writeJsonSuccess,
  type OutputStreams,
} from "./output.js";

export const VERSION = "0.2.0";
const DEFAULT_API_URL = "https://kbdrop.io";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type CliDependencies = {
  store?: CredentialStore;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
  stdin?: Readable & { isTTY?: boolean };
  stdout?: Pick<Writable, "write">;
  stderr?: Pick<Writable, "write">;
};

const HELP = `kb-drop ${VERSION}

Usage:
  kb-drop auth login [--manage] [--device] [--no-browser]
  kb-drop auth logout
  kb-drop auth status [--json]
  kb-drop ask [question] [options]
  kb-drop search [query] [options]
  kb-drop knowledge-bases create --file PATH|--zip PATH|--url URL|--video-url URL [options]
  kb-drop knowledge-bases status ID [--watch]
  kb-drop knowledge-bases list [--limit N] [--cursor CURSOR]
  kb-drop knowledge-bases retry ID [--wait]
  kb-drop knowledge-bases recrawl ID [--wait]
  kb-drop completion bash|zsh|fish

  kb is short for knowledge-bases.

Common options:
  --api-url URL              API origin (default: https://kbdrop.io)
  --knowledge-base ID        Knowledge-base UUID (--kb is an alias)
  --input TEXT|-             Question text, or - to read stdin
  --input-file FILE          Read question/query text from a UTF-8 file
  --json                     Emit one versioned JSON object on stdout
  --timeout MS               Per-request timeout, 1000-120000 (default: 30000)
  --retries N                Retry 429/503/network failures, 0-5 (default: 2)

Ask controls:
  --citation-detail compact|full
  --include-excerpts         Include citation excerpts
  --include-usage            Include token and cost usage
  --include-latency          Include latency details
  --max-answer-tokens N      Bound answer output, 128-4096
  --response-schema FILE     Require grounded output matching JSON Schema
  --conversation ID          Continue a conversation
  --idempotency-key UUID     Reuse a caller-selected operation key
  --stream-compat            Opt into the legacy SSE representation

Search controls:
  --top-k N                  Return 1-20 results (default: 5)
  --language NAME            Repeat for language filters
  --path-prefix PATH         Restrict results to a relative path

Create sources (choose one):
  --file PATH                Upload a document, archive, audio, or video file (up to 1 GiB)
  --zip PATH                 Upload a .zip archive
  --url URL                  Crawl a public website
  --video-url URL            Transcribe a public video

Create controls:
  --name NAME                Knowledge-base name, 1-120 characters
  --wait                     Wait until ingestion finishes (status uses --watch)
  --wait-timeout SECONDS     Stop waiting after 1-86400 seconds (default: 1800)
  --parallel N               Upload 1-8 parts at once (default: 4)
  --idempotency-key UUID     Use your own key instead of saved resume state

Website controls (with --url):
  --mode site|single_url     Crawl the site, or index one page (default: site)
  --max-pages N              Stop after 1-1000 pages (default: 100)
  --max-depth N              Follow links 0-10 levels deep (default: 3)
  --include-path PATTERN     Crawl only matching paths, e.g. /docs/*; repeatable
  --exclude-path PATTERN     Skip matching paths; repeatable
  --include-subdomains       Include subdomains
  --allow-documents          Follow linked PDFs and documents
  --render-mode auto|always|never
                             JavaScript rendering (default: auto)
  --query-policy drop_tracking|strip|preserve
                             Query strings (default: drop_tracking)

Exit codes:
  0 success, 2 usage, 3 authentication, 4 request rejected, 5 temporary
  failure, 6 network, 7 unexpected response, 8 insufficient evidence,
  9 ingestion failed or was cancelled, 10 stopped waiting before ingestion finished

Environment:
  KB_DROP_API_URL            Default for --api-url
  KB_DROP_KNOWLEDGE_BASE_ID  Default knowledge base for ask and search
  KB_DROP_STATE_DIR          Where unfinished commands keep their resume state

Authentication:
  OAuth credentials are stored in the native OS credential store.
  ask and search use KB_DROP_API_KEY, then KB_DROP_MANAGEMENT_KEY, then the saved login.
  knowledge-bases uses KB_DROP_MANAGEMENT_KEY, then a login from \`auth login --manage\`.
  Secrets are never accepted as arguments.`;

function streams(dependencies: CliDependencies): OutputStreams {
  return {
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
  };
}

function apiUrl(
  arguments_: ParsedArguments,
  environment: NodeJS.ProcessEnv,
): string {
  return normalizeApiUrl(
    option(arguments_, "api-url") ??
      environment.KB_DROP_API_URL ??
      DEFAULT_API_URL,
  );
}

function knowledgeBaseId(
  arguments_: ParsedArguments,
  environment: NodeJS.ProcessEnv,
): string {
  const short = option(arguments_, "kb");
  const long = option(arguments_, "knowledge-base");
  if (short && long) {
    throw new CliError(
      "usage",
      "knowledge_base_conflict",
      "Provide --knowledge-base or --kb, not both.",
    );
  }
  const value = long ?? short ?? environment.KB_DROP_KNOWLEDGE_BASE_ID;
  if (!value) {
    throw new CliError(
      "usage",
      "knowledge_base_required",
      "Provide --knowledge-base/--kb or set KB_DROP_KNOWLEDGE_BASE_ID.",
    );
  }
  if (!UUID_PATTERN.test(value)) {
    throw new CliError(
      "usage",
      "knowledge_base_invalid",
      "The knowledge-base ID must be a UUID.",
    );
  }
  return value;
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function commandInput(
  arguments_: ParsedArguments,
  stdin: Readable & { isTTY?: boolean },
  command: "ask" | "search",
): Promise<string> {
  const query = command === "search" ? option(arguments_, "query") : undefined;
  const inputText = option(arguments_, "input");
  const literal = query ?? inputText;
  const inputPath = option(arguments_, "input-file");
  const provided = [
    query !== undefined,
    inputText !== undefined,
    inputPath !== undefined,
    arguments_.positionals.length > 0,
  ].filter(Boolean).length;
  if (provided > 1) {
    throw new CliError(
      "usage",
      "input_conflict",
      "Provide text as arguments, --input/--query, or --input-file, not more than one.",
    );
  }
  let value: string;
  if (literal === "-") value = await readStream(stdin);
  else if (literal !== undefined) value = literal;
  else if (inputPath) {
    try {
      value = await readFile(inputPath, "utf8");
    } catch {
      throw new CliError(
        "usage",
        "input_file_unreadable",
        "The input file could not be read.",
      );
    }
  } else if (arguments_.positionals.length > 0) {
    value = arguments_.positionals.join(" ");
  } else if (!stdin.isTTY) {
    value = await readStream(stdin);
  } else {
    throw new CliError(
      "usage",
      "input_required",
      "Provide a question/query, or use --input, --query, or --input-file.",
    );
  }
  value = value.trim();
  if (!value) throw new CliError("usage", "input_required", "Input must not be empty.");
  if (value.length > 4_000) {
    throw new CliError(
      "usage",
      "input_too_long",
      "Input may contain at most 4,000 characters.",
    );
  }
  return value;
}

function completionScript(shell: string): string {
  const commands = "auth ask search knowledge-bases kb completion";
  const subcommands = `login logout status ${KNOWLEDGE_BASE_COMMANDS.join(" ")}`;
  const common =
    "--help --version --json --api-url --knowledge-base --kb --input --input-file --timeout --retries --manage --file --zip --url --video-url --name --wait --watch --wait-timeout --parallel --limit --cursor --mode --max-pages --max-depth --include-path --exclude-path --include-subdomains --allow-documents --render-mode --query-policy";
  if (shell === "bash") {
    return `_kb_drop_complete() {\n  local current=\"\${COMP_WORDS[COMP_CWORD]}\"\n  COMPREPLY=( $(compgen -W \"${commands} ${subcommands} ${common}\" -- \"$current\") )\n}\ncomplete -F _kb_drop_complete kb-drop`;
  }
  if (shell === "zsh") {
    return `#compdef kb-drop\n_arguments '1:command:(${commands})' '*:argument:(${subcommands} bash zsh fish ${common})'`;
  }
  if (shell === "fish") {
    return `complete -c kb-drop -f -a '${commands}'\ncomplete -c kb-drop -n '__fish_seen_subcommand_from auth' -a 'login logout status'\ncomplete -c kb-drop -n '__fish_seen_subcommand_from knowledge-bases kb' -a '${KNOWLEDGE_BASE_COMMANDS.join(" ")}'`;
  }
  throw new CliError(
    "usage",
    "shell_invalid",
    "Completion shell must be bash, zsh, or fish.",
  );
}

async function responseSchema(arguments_: ParsedArguments): Promise<unknown> {
  const path = option(arguments_, "response-schema");
  if (!path) return undefined;
  let encoded: string;
  try {
    encoded = await readFile(path, "utf8");
  } catch {
    throw new CliError(
      "usage",
      "response_schema_unreadable",
      "The response schema file could not be read.",
    );
  }
  if (Buffer.byteLength(encoded) > 16 * 1_024) {
    throw new CliError(
      "usage",
      "response_schema_too_large",
      "The response schema may be at most 16 KiB.",
    );
  }
  try {
    return JSON.parse(encoded) as unknown;
  } catch {
    throw new CliError(
      "usage",
      "response_schema_invalid",
      "The response schema file must contain valid JSON.",
    );
  }
}

export async function runCli(
  argv: string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const output = streams(dependencies);
  let json = argv.includes("--json");
  try {
    let arguments_ = parseArguments(argv);
    json = hasOption(arguments_, "json");
    if (hasOption(arguments_, "version")) {
      output.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (!arguments_.command || hasOption(arguments_, "help")) {
      output.stdout.write(`${HELP}\n`);
      return 0;
    }
    let outputCommand = arguments_.command;
    if (arguments_.command === "auth") {
      const [subcommand, ...remaining] = arguments_.positionals;
      if (!subcommand || !["login", "logout", "status"].includes(subcommand)) {
        throw new CliError(
          "usage",
          "auth_command_required",
          "Use `kb-drop auth login`, `auth status`, or `auth logout`.",
        );
      }
      arguments_ = {
        ...arguments_,
        command: subcommand,
        positionals: remaining,
      };
      outputCommand = `auth.${subcommand}`;
    }
    const environment = dependencies.environment ?? process.env;
    const origin = apiUrl(arguments_, environment);
    const store = dependencies.store ?? new NativeCredentialStore();
    const command = arguments_.command;
    if (!command) {
      throw new CliError("usage", "command_required", "Choose a command.");
    }

    if (command === "knowledge-bases" || command === "kb") {
      const [subcommand, ...remaining] = arguments_.positionals;
      if (!subcommand || !KNOWLEDGE_BASE_COMMANDS.includes(subcommand)) {
        throw new CliError(
          "usage",
          "knowledge_base_command_required",
          `Use \`kb-drop knowledge-bases ${KNOWLEDGE_BASE_COMMANDS.join("|")}\`.`,
        );
      }
      return await runKnowledgeBaseCommand({
        arguments_: { ...arguments_, command: subcommand, positionals: remaining },
        subcommand,
        origin,
        environment,
        json,
        output,
        store,
        fetchImpl: dependencies.fetchImpl,
        sleep:
          dependencies.sleep ??
          ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
        now: dependencies.now ?? Date.now,
      });
    }

    if (
      ["login", "logout", "status"].includes(command) &&
      arguments_.positionals.length > 0
    ) {
      throw new CliError(
        "usage",
        "unexpected_argument",
        `${outputCommand} does not accept positional arguments.`,
      );
    }

    if (command === "completion") {
      ensureAllowed(arguments_, command, []);
      if (arguments_.positionals.length !== 1) {
        throw new CliError(
          "usage",
          "shell_required",
          "Provide one completion shell: bash, zsh, or fish.",
        );
      }
      output.stdout.write(`${completionScript(arguments_.positionals[0]!)}\n`);
      return 0;
    }

    if (command === "login") {
      ensureAllowed(arguments_, command, ["device", "manage", "no-browser", "timeout"]);
      const scope = hasOption(arguments_, "manage") ? MANAGEMENT_SCOPE : QUERY_SCOPE;
      const timeoutMs = integerOption(arguments_, "timeout", 300_000, {
        min: 30_000,
        max: 900_000,
      });
      const loginDependencies = {
        store,
        fetchImpl: dependencies.fetchImpl,
        openUrl: dependencies.openUrl,
        sleep: dependencies.sleep,
        now: dependencies.now,
        stderr: output.stderr,
      };
      const saved = hasOption(arguments_, "device")
        ? await deviceLogin(origin, loginDependencies, {
            openBrowser: !hasOption(arguments_, "no-browser"),
            scope,
          })
        : await browserLogin(origin, loginDependencies, {
            openBrowser: !hasOption(arguments_, "no-browser"),
            timeoutMs,
            scope,
          });
      const result = {
        api_url: origin,
        account: saved.account.email,
        scope: saved.scope.split(" "),
        credential_store: store.backendName
          ? await store.backendName()
          : "injected",
      };
      const canManage = grantsScope(saved.scope, "knowledge_bases:write");
      if (hasOption(arguments_, "manage") && !canManage) {
        throw new CliError(
          "auth",
          "management_scope_not_granted",
          "The login succeeded, but knowledge-base management was not approved.",
        );
      }
      if (json) writeJsonSuccess(output, outputCommand, result);
      else {
        output.stdout.write(
          `Logged in to ${origin} as ${saved.account.email}${
            canManage ? ", with knowledge-base management" : ""
          }.\n`,
        );
      }
      return 0;
    }

    if (command === "logout") {
      ensureAllowed(arguments_, command, []);
      const removed = await logout(origin, {
        store,
        fetchImpl: dependencies.fetchImpl,
      });
      if (json) {
        writeJsonSuccess(output, outputCommand, { api_url: origin, removed });
      }
      else output.stdout.write(removed ? "Logged out.\n" : "No saved OAuth login.\n");
      return 0;
    }

    if (command === "status") {
      ensureAllowed(arguments_, command, []);
      const apiKey = environmentApiKey(environment);
      const managementKey = environmentManagementKey(environment);
      // The saved login is read only when some command would fall back to it.
      // Without an OS keychain, KB_DROP_API_KEY still authenticates.
      const saved = managementKey
        ? null
        : await store.get(origin).catch((error: unknown) => {
            if (apiKey && error instanceof CliError && error.code === "keychain_unavailable") {
              return null;
            }
            throw error;
          });
      const savedUsable =
        saved !== null &&
        (Boolean(saved.refreshToken) ||
          Date.parse(saved.accessExpiresAt) > (dependencies.now ?? Date.now)());
      const source = apiKey || managementKey ? "environment" : saved ? "oauth" : null;
      const result = {
        authenticated: source === "environment" || savedUsable,
        source,
        api_url: origin,
        account: source === "oauth" ? saved!.account.email : null,
        expires_at: source === "oauth" ? saved!.accessExpiresAt : null,
        // Which credential `knowledge-bases` commands use, if any.
        management: managementKey
          ? "environment"
          : savedUsable && grantsScope(saved!.scope, "knowledge_bases:write")
            ? "oauth"
            : null,
      };
      if (json) writeJsonSuccess(output, outputCommand, result);
      else {
        output.stdout.write(
          !result.authenticated
            ? `Not logged in to ${origin}.\n`
            : source === "environment"
              ? `Authenticated to ${origin} with ${apiKey ? "KB_DROP_API_KEY" : "KB_DROP_MANAGEMENT_KEY"}.\n`
              : `Logged in to ${origin} as ${result.account}.\n`,
        );
        output.stdout.write(
          result.management === "environment"
            ? "Knowledge-base management: KB_DROP_MANAGEMENT_KEY.\n"
            : result.management === "oauth"
              ? "Knowledge-base management: allowed by the saved login.\n"
              : "Knowledge-base management: not set up. Run `kb-drop auth login --manage` or set KB_DROP_MANAGEMENT_KEY.\n",
        );
      }
      return 0;
    }

    if (command !== "ask" && command !== "search") {
      throw new CliError("usage", "unknown_command", `Unknown command ${command}.`);
    }
    ensureAllowed(
      arguments_,
      command,
      command === "ask"
        ? [
            "citation-detail",
            "conversation",
            "idempotency-key",
            "include-excerpts",
            "include-latency",
            "include-usage",
            "input",
            "input-file",
            "kb",
            "knowledge-base",
            "max-answer-tokens",
            "response-schema",
            "retries",
            "stream-compat",
            "timeout",
          ]
        : [
            "input",
            "input-file",
            "kb",
            "knowledge-base",
            "language",
            "path-prefix",
            "query",
            "retries",
            "timeout",
            "top-k",
          ],
    );
    const kb = knowledgeBaseId(arguments_, environment);
    const input = await commandInput(
      arguments_,
      dependencies.stdin ?? process.stdin,
      command,
    );
    const auth = await authorizationForApi(
      origin,
      { store, fetchImpl: dependencies.fetchImpl, now: dependencies.now },
      environment,
    );
    const retry = {
      retries: integerOption(arguments_, "retries", 2, { min: 0, max: 5 }),
      timeoutMs: integerOption(arguments_, "timeout", 30_000, {
        min: 1_000,
        max: 120_000,
      }),
      fetchImpl: dependencies.fetchImpl,
      sleep: dependencies.sleep,
    };
    const client = new ApiClient(origin, auth.authorization, retry);
    if (command === "ask") {
      const citationDetail = option(arguments_, "citation-detail");
      if (citationDetail && citationDetail !== "compact" && citationDetail !== "full") {
        throw new CliError(
          "usage",
          "citation_detail_invalid",
          "--citation-detail must be compact or full.",
        );
      }
      const conversationId = option(arguments_, "conversation");
      const idempotencyKey = option(arguments_, "idempotency-key");
      for (const [name, value] of [
        ["conversation", conversationId],
        ["idempotency-key", idempotencyKey],
      ] as const) {
        if (value && !UUID_PATTERN.test(value)) {
          throw new CliError("usage", "uuid_invalid", `--${name} must be a UUID.`);
        }
      }
      const streaming = hasOption(arguments_, "stream-compat");
      let streamed = false;
      const completion = await client.ask(kb, input, {
        conversationId,
        idempotencyKey,
        stream: streaming,
        citationDetail: citationDetail as "compact" | "full" | undefined,
        includeExcerpts: hasOption(arguments_, "include-excerpts") || undefined,
        includeUsage: hasOption(arguments_, "include-usage") || undefined,
        includeLatency: hasOption(arguments_, "include-latency") || undefined,
        maxAnswerTokens: hasOption(arguments_, "max-answer-tokens")
          ? integerOption(arguments_, "max-answer-tokens", 1_024, {
              min: 128,
              max: 4_096,
            })
          : undefined,
        responseSchema: await responseSchema(arguments_),
        onDelta:
          streaming && !json
            ? (delta) => {
                streamed = true;
                output.stdout.write(delta);
              }
            : undefined,
      });
      if (json) writeJsonSuccess(output, command, completion);
      else writeHumanAnswer(output, completion, streamed);
      return completion.insufficient_evidence
        ? INSUFFICIENT_EVIDENCE_EXIT_CODE
        : 0;
    }

    const result = await client.search(kb, {
      query: input,
      topK: integerOption(arguments_, "top-k", 5, { min: 1, max: 20 }),
      languages: options(arguments_, "language"),
      pathPrefix: option(arguments_, "path-prefix"),
    });
    if (json) writeJsonSuccess(output, command, result);
    else writeHumanSearch(output, result);
    return 0;
  } catch (error) {
    return writeError(output, error, json);
  }
}
