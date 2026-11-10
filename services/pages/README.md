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
| Address | `https://pages-dev.kiloapps.io` |
| First deployed | 2026-11-10, from `nteract/nteract` at `3c22117f7`, version `e11cd161-d009-4619-8cdb-b8464a0a17a1` |
| Running now | `nteract/nteract` PR 4963 at `5f3379fb7` (main at `a3bd8130f` plus the packaging change), version `a9ff34e1-750a-4f87-b422-da8708cc7c6d` |
| Build id | `cdb234a8943e` (reported by `/health`) |
| D1, auth and catalog | `pages-dev-auth` (`13db1af4-e01e-447d-ae51-cc37625d5f77`) |
| D1, usage | `pages-dev-usage` (`8691d489-5105-49f4-bbec-63ecbca319e9`) |
| R2 | `pages-dev-assets` |
| Durable Objects | `Page`, `Catalog`, `PageRecords`, `Space` (SQLite classes) |
| Cron triggers | `5 0 * * *`, `35 * * * *` |
| Secret | `NOTEBOOK_CLOUD_APP_SESSION_KEYS`, a session keyring |

[profiles/dev.json](profiles/dev.json) is the exact profile the package was
built from. It holds no secret.

## Hostname

`pages-dev.kiloapps.io` is a Workers custom domain on the `kiloapps.io` zone,
attached on 2026-11-10. It is the Worker's public origin
(`NOTEBOOK_CLOUD_PUBLIC_ORIGIN`): links, the MCP metadata and browser origin
checks all use it.

The first address, `https://pages-dev.engineering-e11.workers.dev`, is off:
the profile has `workers_dev: false`, and that address answers 404. Nothing
was ever pointed at it.

The profile names the hostname and its zone under `custom_domain`, and the
packaging script turns that into the route (nteract/nteract PR 4963). Until
that PR merges, deploy from its branch, `pages/cloudflare-profile-domain`.
Do not use `wrangler deploy --domain`: it can't name the zone, and the API
answers "Can't infer zone from route".

## Who can sign in

Anaconda API keys only. The Worker checks a key with Anaconda and names the
account `kilo-pages-dev-anaconda:<id>`. There is no browser sign-in yet:
`/api/auth/login` answers 503. Kilo sign-in is the next phase.

The address is public. Any Anaconda account holder with an API key can create
Pages on it. Treat its data as disposable.

## Deploy again

From a clean checkout of `nteract/nteract`, in `apps/pages`. The tree must
have no untracked files when it is built, or the stage step refuses the build:

```sh
npm run build
node scripts/cloudflare-stage.mjs NEW_EMPTY_DIR services/pages/profiles/dev.json
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
- A signed-in round trip with an Anaconda API key passes: list, create, read,
  edit, comment, read changes, upload an image to R2, place it, read it back
  byte for byte, and trash the Page. An anonymous read of the image answers 401.

Timings from that round trip, one client in North America: the first
`list_pages` on a cold Worker took 2.7 s and `create_page` 1.2 s. Later calls
took 70 to 480 ms.

## Checked after the hostname change

- `https://pages-dev.kiloapps.io/health` answers `ok` with the build id above.
- `/`, `/connect` and `/llms.txt` answer 200, and `/llms.txt` names only the
  new origin.
- The OAuth metadata names `https://pages-dev.kiloapps.io` as issuer.
- Anonymous `/mcp` answers 401. `/api/auth/session` answers signed out.
- `/api/auth/login` still answers 503: there is no browser sign-in yet.
- The `workers.dev` address answers 404.

## Not checked yet

- Browser sign-in. It arrives with Kilo sign-in.
- Live sync over WebSocket between two clients.
- Image import from a ChatGPT attachment.
- Memory limits, hibernation and cold-start time. The limits in this build are
  sized for a large single host, not for Workers.
