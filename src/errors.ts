export type CliErrorKind =
  | "usage"
  | "auth"
  | "request"
  | "transient"
  | "network"
  | "output"
  | "unexpected";

export const EXIT_CODES: Record<CliErrorKind, number> = {
  usage: 2,
  auth: 3,
  request: 4,
  transient: 5,
  network: 6,
  output: 7,
  unexpected: 70,
};

export const INSUFFICIENT_EVIDENCE_EXIT_CODE = 8;
/** The reported ingestion job failed or was cancelled. */
export const INGESTION_FAILED_EXIT_CODE = 9;
/** `--wait`/`--watch` ended before ingestion reached a terminal state. */
export const WAIT_TIMED_OUT_EXIT_CODE = 10;

export class CliError extends Error {
  constructor(
    public readonly kind: CliErrorKind,
    public readonly code: string,
    message: string,
    public readonly details: {
      status?: number;
      retryAfterSeconds?: number;
      requestId?: string;
      recovery?: string;
    } = {},
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new CliError("network", "request_timed_out", "The request timed out.");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CliError("network", "request_aborted", "The request was cancelled.");
  }
  return new CliError(
    "unexpected",
    "unexpected_failure",
    "The command could not be completed.",
  );
}
