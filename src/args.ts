import { CliError } from "./errors.js";

const BOOLEAN_OPTIONS = new Set([
  "allow-documents",
  "device",
  "help",
  "include-excerpts",
  "include-latency",
  "include-subdomains",
  "include-usage",
  "json",
  "manage",
  "no-browser",
  "stream-compat",
  "version",
  "wait",
  "watch",
]);
const VALUE_OPTIONS = new Set([
  "api-url",
  "citation-detail",
  "conversation",
  "cursor",
  "exclude-path",
  "file",
  "idempotency-key",
  "include-path",
  "input",
  "input-file",
  "kb",
  "knowledge-base",
  "language",
  "limit",
  "max-answer-tokens",
  "max-depth",
  "max-pages",
  "mode",
  "name",
  "parallel",
  "path-prefix",
  "query",
  "query-policy",
  "render-mode",
  "response-schema",
  "retries",
  "timeout",
  "top-k",
  "url",
  "video-url",
  "wait-timeout",
  "zip",
]);
const REPEATABLE_OPTIONS = new Set(["exclude-path", "include-path", "language"]);
// Rejected by name so a secret never reaches shell history or process lists.
const SECRET_OPTIONS = new Set([
  "access-token",
  "api-key",
  "key",
  "management-key",
  "token",
]);

export type ParsedArguments = {
  command: string | null;
  positionals: string[];
  options: Map<string, string[]>;
};

function addOption(
  options: Map<string, string[]>,
  name: string,
  value: string,
): void {
  options.set(name, [...(options.get(name) ?? []), value]);
}

export function parseArguments(argv: string[]): ParsedArguments {
  const options = new Map<string, string[]>();
  const positionals: string[] = [];
  let command: string | null = null;
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && argument.startsWith("--")) {
      // Split at the first "=" only: URLs and paths may contain more.
      const separator = argument.indexOf("=");
      const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
      const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1);
      if (SECRET_OPTIONS.has(name)) {
        throw new CliError(
          "usage",
          "secret_argument_forbidden",
          "Do not pass secrets on the command line. Use OAuth login, KB_DROP_API_KEY, or KB_DROP_MANAGEMENT_KEY.",
        );
      }
      if (BOOLEAN_OPTIONS.has(name)) {
        if (inlineValue !== undefined) {
          throw new CliError(
            "usage",
            "invalid_option",
            `--${name} does not accept a value.`,
          );
        }
        addOption(options, name, "true");
        continue;
      }
      if (!VALUE_OPTIONS.has(name)) {
        throw new CliError("usage", "unknown_option", `Unknown option --${name}.`);
      }
      const value = inlineValue ?? argv[index + 1];
      if (!value || (inlineValue === undefined && value.startsWith("--"))) {
        throw new CliError(
          "usage",
          "missing_option_value",
          `--${name} requires a value.`,
        );
      }
      if (inlineValue === undefined) index += 1;
      addOption(options, name, value);
      continue;
    }
    if (!command) command = argument;
    else positionals.push(argument);
  }
  return { command, positionals, options };
}

export function hasOption(arguments_: ParsedArguments, name: string): boolean {
  return arguments_.options.has(name);
}

export function option(
  arguments_: ParsedArguments,
  name: string,
): string | undefined {
  const values = arguments_.options.get(name);
  if ((values?.length ?? 0) > 1 && !REPEATABLE_OPTIONS.has(name)) {
    throw new CliError(
      "usage",
      "duplicate_option",
      `--${name} may only be provided once.`,
    );
  }
  return values?.[0];
}

export function options(arguments_: ParsedArguments, name: string): string[] {
  return arguments_.options.get(name) ?? [];
}

export function integerOption(
  arguments_: ParsedArguments,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = option(arguments_, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new CliError(
      "usage",
      "invalid_option_value",
      `--${name} must be an integer from ${bounds.min} through ${bounds.max}.`,
    );
  }
  return value;
}

/** Rejects options the command does not use, so a typo never goes unnoticed. */
export function ensureAllowed(
  arguments_: ParsedArguments,
  command: string,
  allowed: string[],
): void {
  const accepted = new Set(["api-url", "help", "json", ...allowed]);
  for (const name of arguments_.options.keys()) {
    if (!accepted.has(name)) {
      throw new CliError(
        "usage",
        "option_not_supported",
        `--${name} is not supported by ${command}.`,
      );
    }
  }
}
