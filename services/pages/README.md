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
| Running now | `nteract/nteract` main at `5aeffeae6`, version `9a91405c-8a83-40e6-9e43-0965513121f8` |
| Build id | `2ec15ab8a18b` (reported by `/health`) |
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
packaging script turns that into the route (nteract/nteract PR 4963, on main
from `c293adb0e`).
Do not use `wrangler deploy --domain`: it can't name the zone, and the API
answers "Can't infer zone from route".

## Who can sign in

Kilo accounts, through the web app. `PAGES_KILO_APP_URL` in the profile is
`https://app.kilo.ai`. `/api/auth/login` sends the browser to
`/pages-auth` there with this deployment's origin and a one-time `state`.
Kilo sends it back to `/api/auth/kilo/callback` with a code, and the Worker
trades the code at `/api/pages-auth/exchange` for the account's id, name and
organizations. Pages holds no Kilo token. A session lasts 8 hours and is not
renewed: the browser goes through Kilo again. The account is named
`user:kilo:<id>`.

Two secrets hold the same value, and neither is in this repository:

- `PAGES_KILO_EXCHANGE_SECRET`, a Worker secret on `pages-dev`.
- `PAGES_DEV_AUTH_SECRET`, in the web app's Vercel environment
  (`pnpm web:env set`, see `DEVELOPMENT.md`).

To rotate, set a new value in both places. Until both match, sign-in fails
and nothing else changes.

Anaconda API keys still work for tools. The Worker checks a key with Anaconda
and names the account `kilo-pages-dev-anaconda:<id>`. They go away when the
agent sign-in path for Kilo accounts lands.

The address is public. Anyone with a Kilo account can sign in, and any
Anaconda account holder with an API key can create Pages. Treat its data as
disposable.

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

## Checked after Kilo sign-in was turned on

- `/api/auth/login` answers 302 to `https://app.kilo.ai/pages-auth` with this
  origin and a 43-character `state`, and sets the `__Host-pages_kilo_handoff`
  cookie (HttpOnly, Secure, SameSite=Lax, 10 minutes).
- Kilo answers that link 307 to its sign-in page for a browser with no Kilo
  session. It answers 400 for `pages.kiloapps.io`, which has no secret yet, and
  for an origin that is not on its list.
- A callback with a made-up code answers 400.
- `wrangler secret list` shows both secret names on the Worker.

## Not checked yet

- A person signing in end to end with a Kilo account, and a second browser
  failing to finish a link the first one started.
- Live sync over WebSocket between two clients.
- Image import from a ChatGPT attachment.
- Memory limits, hibernation and cold-start time. The limits in this build are
  sized for a large single host, not for Workers.
