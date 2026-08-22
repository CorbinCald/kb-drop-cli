import type { Writable } from "node:stream";
import { asCliError, EXIT_CODES } from "./errors.js";
import type { AskCompletion, SearchResponse } from "./types.js";

export const CLI_SCHEMA_VERSION = "1";

export type OutputStreams = {
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
};

function line(stream: Pick<Writable, "write">, value = ""): void {
  stream.write(`${value}\n`);
}

export function writeJsonSuccess(
  streams: OutputStreams,
  command: string,
  data: unknown,
): void {
  line(
    streams.stdout,
    JSON.stringify({
      schema_version: CLI_SCHEMA_VERSION,
      ok: true,
      command,
      data,
    }),
  );
}

export function writeError(
  streams: OutputStreams,
  error: unknown,
  json: boolean,
): number {
  const failure = asCliError(error);
  const payload = {
    schema_version: CLI_SCHEMA_VERSION,
    ok: false,
    error: {
      code: failure.code,
      message: failure.message,
      ...(failure.details.status ? { status: failure.details.status } : {}),
      ...(failure.details.retryAfterSeconds !== undefined
        ? { retry_after_seconds: failure.details.retryAfterSeconds }
        : {}),
      ...(failure.details.requestId
        ? { request_id: failure.details.requestId }
        : {}),
    },
  };
  line(
    streams.stderr,
    json ? JSON.stringify(payload) : `kb-drop: ${failure.message} (${failure.code})`,
  );
  return EXIT_CODES[failure.kind];
}

export function writeHumanAnswer(
  streams: OutputStreams,
  completion: AskCompletion,
  alreadyStreamed = false,
): void {
  if (!alreadyStreamed) {
    if (completion.output) {
      line(streams.stdout, JSON.stringify(completion.output.value, null, 2));
    } else {
      line(streams.stdout, completion.answer ?? "");
    }
  } else {
    line(streams.stdout);
  }
  if (completion.citations.length > 0) {
    line(streams.stdout);
    line(streams.stdout, "Sources:");
    for (const citation of completion.citations) {
      const location = citation.locator_text
        ? ` — ${citation.locator_text}`
        : "";
      const link = citation.source_url ?? citation.deep_link;
      line(
        streams.stdout,
        `[${citation.id}] ${citation.display_title}${location}${link ? ` — ${link}` : ""}`,
      );
    }
  }
}

export function writeHumanSearch(
  streams: OutputStreams,
  response: SearchResponse,
): void {
  if (response.results.length === 0) {
    line(streams.stdout, `No matches (${response.empty.reason ?? "no_matches"}).`);
    return;
  }
  response.results.forEach((result, index) => {
    const lines =
      result.location.start_line === null
        ? ""
        : `:${result.location.start_line}${
            result.location.end_line &&
            result.location.end_line !== result.location.start_line
              ? `-${result.location.end_line}`
              : ""
          }`;
    line(
      streams.stdout,
      `${index + 1}. ${result.source.relative_path}${lines} (${result.score.toFixed(3)})`,
    );
    line(streams.stdout, result.chunk.content);
    if (index < response.results.length - 1) line(streams.stdout);
  });
}
