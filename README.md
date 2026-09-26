# @kbdrop/cli

Official CLI for creating and querying kbDrop knowledge bases.

The CLI is MIT-licensed. Its public source and OIDC release workflow live in
[`CorbinCald/kb-drop-cli`](https://github.com/CorbinCald/kb-drop-cli); npm
releases require maintainer approval with 2FA.

Requires Node.js 24+.

```sh
npx @kbdrop/cli knowledge-bases create --zip ./product-docs.zip --name "Product docs" --wait
npx @kbdrop/cli knowledge-bases create --url https://docs.example.com --name "Public docs" \
  --mode site --max-pages 100 --wait
npx @kbdrop/cli knowledge-bases status "$KB_DROP_KNOWLEDGE_BASE_ID" --watch --json
npx @kbdrop/cli ask --knowledge-base "$KB_DROP_KNOWLEDGE_BASE_ID" --json --input-file ./question.txt
```

Run `kb-drop --help` for every option. `kb` is short for `knowledge-bases`.

## Credentials

The CLI deliberately has no credential arguments; it rejects them so secrets
never reach shell history or process lists.

| Commands | Credential, in order of precedence |
| --- | --- |
| `ask`, `search` | `KB_DROP_API_KEY`, then `KB_DROP_MANAGEMENT_KEY`, then the saved login |
| `knowledge-bases …` | `KB_DROP_MANAGEMENT_KEY`, then a saved login from `auth login --manage` |

- **Management keys** (`kb_mgmt_…`) belong to the account. Create them at
  [kbdrop.io/management-keys](https://kbdrop.io/management-keys) with only the
  permissions needed: `knowledge_bases:write` to create, retry, and recrawl;
  `knowledge_bases:read` to list, check status, and `--wait`. **Rotate** on
  that page shows a new secret once and retires the old one immediately. To
  rotate without downtime, create a second key, switch your secret manager to
  it, then revoke the old one; revocation also takes effect immediately.
- **OAuth**: `auth login` grants asking and searching only.
  `auth login --manage` also requests knowledge-base management, which the
  account owner approves on the consent screen. The login is saved in the
  native OS credential store; `auth logout` revokes and removes it. Both
  browser login and `auth login --device --no-browser` require an unlocked
  store. On `keychain_unavailable`, configure the store or use a key injected
  by a secret manager; repeating the login cannot supply a missing store.
- **Knowledge-base API keys** (`kb_live_…`) only ask and search their own
  knowledge base. The CLI never sends them to management endpoints.

`auth status --json` reports `data.authenticated`, `data.source`, and
`data.management` (`"environment"`, `"oauth"`, or `null` when
`knowledge-bases` commands have no credential). It exits `0` even when logged
out.

## Configuration

The CLI has no configuration file; options and environment variables set
everything.

| Setting | Purpose |
| --- | --- |
| `--api-url URL` or `KB_DROP_API_URL` | kbDrop origin, `https://kbdrop.io` by default. Plain HTTP is accepted only for `localhost`, `127.0.0.1`, and `[::1]` |
| `KB_DROP_MANAGEMENT_KEY`, `KB_DROP_API_KEY` | Credentials, as above |
| `KB_DROP_KNOWLEDGE_BASE_ID` | Default knowledge base for `ask` and `search`; `knowledge-bases` commands always take the ID explicitly |
| `KB_DROP_STATE_DIR` | Where unfinished commands keep their resume state; see [Uploads and resuming](#uploads-and-resuming) |
| `--timeout MS`, `--retries N` | Per-request timeout (1000–120000, default 30000) and retries after `429`, `503`, or a network failure (0–5, default 2) |

## Creating knowledge bases

Choose exactly one source:

| Option | Source |
| --- | --- |
| `--file PATH` | A document, archive, audio, or video file, up to 1 GiB |
| `--zip PATH` | A `.zip` archive |
| `--url URL` | A public website, with the browser's crawl settings below |
| `--video-url URL` | A public video URL |

`--name` sets the name (1–120 characters); otherwise kbDrop names it after the
source.

Website settings apply only with `--url` and match the web app; unset ones use
kbDrop's defaults:

| Option | Default |
| --- | --- |
| `--mode site\|single_url` | `site` |
| `--max-pages N` (1–1000) | 100 |
| `--max-depth N` (0–10) | 3 |
| `--include-path PATTERN`, `--exclude-path PATTERN` (repeat up to 20 times; start with `/`) | none |
| `--include-subdomains` | off |
| `--allow-documents` (follow linked PDFs and documents) | off |
| `--render-mode auto\|always\|never` (JavaScript rendering) | `auto` |
| `--query-policy drop_tracking\|strip\|preserve` (query strings) | `drop_tracking` |

### Uploads and resuming

Files go straight to kbDrop's object storage in parts, `--parallel` (1–8,
default 4) at a time. Each part is retried with backoff, and an expired upload
URL is signed again. The CLI checks that the file does not change during the
upload.

Before sending anything, the CLI saves an idempotency key for the command in
its state directory. If the command is interrupted — Ctrl-C, a crash, a lost
connection, or a `--wait` timeout — **run the same command again**: it resumes
the same knowledge base and uploads only the parts storage has not confirmed.
It never creates a second knowledge base, job, or quota reservation for the
same run. Once a command finishes, its key is forgotten, so running it again
creates another knowledge base. Unfinished keys expire after 24 hours. If the
interrupted upload itself expired, the CLI says so and starts a new knowledge
base. `retry` saves the failed attempt it retries in the same way, so running it
again follows that attempt instead of queuing another.

The state directory is `KB_DROP_STATE_DIR`, or by default
`$XDG_STATE_HOME/kb-drop` (`~/.local/state/kb-drop`) on Linux,
`~/Library/Application Support/kb-drop` on macOS, and `%LOCALAPPDATA%\kb-drop`
on Windows. Records hold only a key, or a retried job's ID and attempt, and a
timestamp, never credentials, file contents, or paths. To manage keys yourself
instead, pass `--idempotency-key UUID`: the same key and request always return
the same knowledge base, and the same key with a different request fails with
`idempotency_mismatch`.

### Waiting, status, and follow-up

- `create --wait`, `retry --wait`, and `recrawl --wait` wait for ingestion;
  `status --watch` does the same for an existing knowledge base. Waiting polls
  at the pace the server asks for, rides out short outages, and stops after
  `--wait-timeout` seconds (1–86400, default 1800); no poll runs past that.
- `status ID` reports the knowledge base and its latest ingestion job.
- `list [--limit N] [--cursor CURSOR]` pages through the account's knowledge
  bases, newest first.
- `retry ID` requeues a failed job when its `next_action` is `retry`. Rerun
  after an interruption, it follows the attempt it already queued; once it has
  reported how that attempt ended, running it again retries anew.
- `recrawl ID` crawls a website knowledge base again as a new version; the
  current version keeps answering until the new one is ready.

## Output and exit codes

With `--json`, stdout carries exactly one object:
`{"schema_version":"1","ok":true,"command":"knowledge-bases.create","data":{…}}`.
For `create`, `data` holds `knowledge_base`, `ingestion_job`, `upload` (`null`
for URLs), `resumed`, and `idempotency_key`; `status` returns `knowledge_base`
and `ingestion_job`, `retry` adds `resumed`, and `recrawl` adds `resumed` and
`idempotency_key`; `list` returns the API's list object. The resources match the
[management API](https://kbdrop.io/docs/api/management.md).

Progress goes to stderr: readable lines by default, or with `--json` one JSON
object per line:
`{"schema_version":"1","event":"progress","command":…,"data":{"stage":"prepare"|"upload"|"ingestion",…}}`.
Errors go to stderr as
`{"schema_version":"1","ok":false,"error":{"code","message","status"?,"retry_after_seconds"?,"request_id"?,"recovery"?}}`.
`recovery` is the management API's machine-readable next step, such as
`wait`, `retry_later`, `request_scope`, `ask_account_owner`, or
`create_new_knowledge_base`. The CLI prints its own messages; it never echoes
server-provided error text.

| Exit | Meaning |
| --- | --- |
| 0 | Success. Without `--wait`/`--watch`, read `data.ingestion_job.status` |
| 2 | Invalid arguments or local input, such as an unreadable file |
| 3 | Authentication or permission; see `recovery` |
| 4 | kbDrop rejected the request; see `recovery` |
| 5 | Temporary; run the same command again later |
| 6 | Network failure; run the same command again to resume |
| 7 | Unexpected response |
| 8 | `ask` found insufficient evidence |
| 9 | Ingestion failed or was cancelled; see `data.ingestion_job.failure` |
| 10 | Stopped waiting before ingestion finished: the timeout passed, or an upload is waiting for the same `create` command to resume it |

Exits 9 and 10 happen only with `--wait` or `--watch`, and stdout still
carries the result.

### Agent pattern

```sh
kb-drop knowledge-bases create --zip ./docs.zip --name "Docs" --wait --json > created.json
case $? in
  0) kb_id="$(node -p 'require("./created.json").data.knowledge_base.id')" ;;
  5|6|10) echo "Run the same command again; it resumes." ;;
  9) node -p 'require("./created.json").data.ingestion_job.failure' ;;
  *) echo "Read the JSON error on stderr and follow its recovery." ;;
esac
```

## Asking and searching

Save the question or query in a UTF-8 file with an editor. Generate and keep a
UUID once for each new logical question:

```sh
export KB_DROP_REQUEST_ID="$(node -p 'crypto.randomUUID()')"
```

```sh
npx @kbdrop/cli ask --knowledge-base "$KB_DROP_KNOWLEDGE_BASE_ID" --json \
  --input-file ./question.txt --idempotency-key "$KB_DROP_REQUEST_ID"
npx @kbdrop/cli search --knowledge-base "$KB_DROP_KNOWLEDGE_BASE_ID" --json \
  --input-file ./query.txt
```

After an ambiguous failure, resume only `ask` with that saved key and unchanged
input and options. Restore the key in a new shell instead of generating
another; a fresh invocation without `--idempotency-key` can create another
turn. After bounded retries fail, keep the key and report the error rather
than looping or starting a new turn to get around it. Repeat `--language` as
needed, but supply `--path-prefix` at most once.

File input keeps question contents out of shell commands; piping a literal
`printf`/`echo` question does not. Never paste credentials into chat or command
arguments.

See the [complete API/CLI contract](https://kbdrop.io/docs/api/reference.md)
for native-store prerequisites, status and error fields, and recovery rules.

## Releasing

Releases use the `publish.yml` GitHub Actions workflow and npm trusted
publishing—no npm token is stored in GitHub. Dispatch the workflow with the
exact version from `package.json`, then review and approve the staged release
on npm with 2FA.

The npm trusted publisher is restricted to GitHub owner `CorbinCald`, repository
`kb-drop-cli`, workflow `publish.yml`, environment `npm`, and the
`npm stage publish` action.
