# Pages

Pages is a service for shared documents that people and agents edit together.
Its source lives in `nteract/nteract` for now. This folder records how the dev
deployment on this Cloudflare account was made, so it can be diagnosed or
repeated.

There is no `wrangler.jsonc` here on purpose. The deploy workflow publishes
every `services/<name>/wrangler.jsonc` to production on merge, and Pages is not
ready for that. The dev Worker is deployed by hand from a profile.

## Dev deployment

| | |
| --- | --- |
| Worker | `pages-dev` |
| Address | `https://pages-dev.engineering-e11.workers.dev` |
| First deployed | 2026-11-10 |
| Source | `nteract/nteract` at `3c22117f7` |
| Build id | `b9ed1befe0e9` (reported by `/health`) |
| First version id | `e11cd161-d009-4619-8cdb-b8464a0a17a1` |
| D1, auth and catalog | `pages-dev-auth` (`13db1af4-e01e-447d-ae51-cc37625d5f77`) |
| D1, usage | `pages-dev-usage` (`8691d489-5105-49f4-bbec-63ecbca319e9`) |
| R2 | `pages-dev-assets` |
| Durable Objects | `Page`, `Catalog`, `PageRecords`, `Space` (SQLite classes) |
| Cron triggers | `5 0 * * *`, `35 * * * *` |
| Secret | `NOTEBOOK_CLOUD_APP_SESSION_KEYS`, a session keyring |

[profiles/dev.json](profiles/dev.json) is the exact profile the package was
built from. It holds no secret.

## Who can sign in

Anaconda API keys only. The Worker checks a key with Anaconda and names the
account `kilo-pages-dev-anaconda:<id>`. There is no browser sign-in yet:
`/api/auth/login` answers 503. Kilo sign-in is the next phase.

The address is public. Any Anaconda account holder with an API key can create
Pages on it. Treat its data as disposable.

## Deploy again

From a clean checkout of `nteract/nteract`, in
`docs/memos/authenticated-automerge-app-substrate/experiment`:

```sh
npm run build --workspace @nteract/pages-native-experiment
node pages/scripts/cloudflare-stage.mjs NEW_EMPTY_DIR services/pages/profiles/dev.json
node_modules/.bin/wrangler deploy --config NEW_EMPTY_DIR/wrangler.json
```

`wrangler deploy` keeps the secret that is already set. To roll back, use
`wrangler rollback --name pages-dev`.

## The session keyring

The keyring was generated on the deploying machine and uploaded with
`wrangler deploy --secrets-file`. Workers secrets are write-only. The only
readable copy is on that machine at `~/.config/pages/kilo-pages-dev.keyring.json`.
Move it to the team secret store before anyone else needs to rotate it.
Losing it only signs browser sessions out; a new keyring can replace it.

## Checked after the first deploy

- `/health` answers `ok` with the build id above.
- Anonymous `POST /mcp` answers 401 with a resource-metadata challenge.
- Anonymous `POST /api/tools` answers 401.
- Plain HTTP answers 308 to HTTPS, and HTTPS answers carry HSTS.
- A refused upload answers 401 with a body of 200 bytes up to 6 MB unread.
- An invalid API key is refused after a live check with Anaconda.
- The Worker created its tables in `pages-dev-auth` on first use.

## Not checked yet

- A signed-in round trip with a real API key: create, read, edit, comment.
- Live sync over WebSocket between two clients.
- Image upload and import against R2.
- Memory limits, hibernation and cold-start time. The limits in this build are
  sized for a large single host, not for Workers.
