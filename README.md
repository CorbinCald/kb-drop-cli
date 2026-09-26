# @kbdrop/cli

Official CLI for querying kbDrop knowledge bases with OAuth or a knowledge-base API key.

The CLI is MIT-licensed. Its public source and OIDC release workflow live in
[`CorbinCald/kb-drop-cli`](https://github.com/CorbinCald/kb-drop-cli); npm
releases require maintainer approval with 2FA.

Requires Node.js 24+. Check `auth status --json` and read `data.authenticated`
and `data.source`; exit `0` also occurs when logged out. An existing environment
`KB_DROP_API_KEY` takes precedence and needs no OAuth/keychain. If unauthenticated,
run `npx @kbdrop/cli auth login`. Both browser login and
`auth login --device --no-browser` require an unlocked native credential store.
On `keychain_unavailable`, configure the store or use an existing key injected
by a secret manager; repeating login cannot supply a missing store.

Save the question/query in UTF-8 files using an editor. Generate and retain a
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
input/options. Restore the key in a new shell instead of generating another;
a fresh invocation without `--idempotency-key` can create another turn. After
bounded retries fail, retain the key and report the error rather than looping
or starting a new turn to bypass it. Repeat `--language` as needed, but supply
`--path-prefix` at most once.

File input keeps question contents out of shell commands; piping a literal
`printf`/`echo` question does not. Never paste credentials into chat or command
arguments; the CLI deliberately has no API-key argument.

Run `kb-drop --help` for response controls, file/stdin input, retries, and the
legacy streaming compatibility option.

See the [complete API/CLI contract](https://kbdrop.io/docs/api/reference.md)
for native-store prerequisites, status/error fields, and recovery rules.

## Releasing

Releases use the `publish.yml` GitHub Actions workflow and npm trusted
publishing—no npm token is stored in GitHub. Dispatch the workflow with the
exact version from `package.json`, then review and approve the staged release
on npm with 2FA.

The npm trusted publisher is restricted to GitHub owner `CorbinCald`, repository
`kb-drop-cli`, workflow `publish.yml`, environment `npm`, and the
`npm stage publish` action.
