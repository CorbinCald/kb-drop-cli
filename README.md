# @kbdrop/cli

Official CLI for querying kbDrop knowledge bases with OAuth or a knowledge-base API key.

The CLI is MIT-licensed. Its public source and OIDC release workflow live in
[`CorbinCald/kb-drop-cli`](https://github.com/CorbinCald/kb-drop-cli); npm
releases require maintainer approval with 2FA.

```sh
npx @kbdrop/cli auth login
npx @kbdrop/cli ask --knowledge-base "$KB_DROP_KNOWLEDGE_BASE_ID" --json \
  --input "What does the runbook say about rollback?"
npx @kbdrop/cli search --knowledge-base "$KB_DROP_KNOWLEDGE_BASE_ID" --json \
  --query "rollback procedure"
```

OAuth credentials are stored in the native OS credential store. For unattended
automation, set `KB_DROP_API_KEY`; the CLI deliberately has no API-key argument.

Run `kb-drop --help` for response controls, file/stdin input, retries, and the
legacy streaming compatibility option.

## Releasing

Releases use the `publish.yml` GitHub Actions workflow and npm trusted
publishing—no npm token is stored in GitHub. Dispatch the workflow with the
exact version from `package.json`, then review and approve the staged release
on npm with 2FA.

The npm trusted publisher is restricted to GitHub owner `CorbinCald`, repository
`kb-drop-cli`, workflow `publish.yml`, environment `npm`, and the
`npm stage publish` action.
