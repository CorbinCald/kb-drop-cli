import { CliError } from "./errors.js";

const BOOLEAN_OPTIONS = new Set([
  "device",
  "help",
  "include-excerpts",
  "include-latency",
  "include-usage",
  "json",
  "no-browser",
  "stream-compat",
  "version",
]);
const VALUE_OPTIONS = new Set([
  "api-url",
  "citation-detail",
  "conversation",
  "idempotency-key",
  "input",
  "input-file",
  "kb",
  "knowledge-base",
  "language",
  "max-answer-tokens",
  "path-prefix",
  "query",
  "response-schema",
  "retries",
  "timeout",
  "top-k",
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
      const [rawName, inlineValue] = argument.slice(2).split("=", 2);
      const name = rawName ?? "";
      if (name === "api-key") {
        throw new CliError(
          "usage",
          "secret_argument_forbidden",
          "Do not pass secrets on the command line. Use OAuth login or KB_DROP_API_KEY.",
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
  if ((values?.length ?? 0) > 1 && name !== "language") {
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
