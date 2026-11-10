# Pages

Pages is a service for shared documents that people and agents edit together.
Its source lives in `nteract/nteract`, directory `apps/pages`, for now. This
folder holds what this repository decides about a deployment: which commit is
built, which Worker and resources it runs on, and how it is deployed. It also
records the dev deployment, so it can be diagnosed or repeated.

| File | Holds |
|---|---|
| `source.json` | The source repository and the full id of the commit that is built |
| `profiles/dev.json` | The dev Worker's name, account, hostname, D1 databases, R2 bucket and plain variables |
| `scripts/stage.mjs` | Fetches the pinned commit, builds it, and writes a package Wrangler deploys as it is |
| `scripts/check-package.mjs` | Refuses a package whose Wrangler configuration names anything the profile does not |
| `package.json` | Wrangler, from this repository's lockfile |

There is no `wrangler.jsonc` here on purpose. `deploy-workers.yml` finds
Workers by that file and publishes each one to production, and Pages is not
ready for that. The Wrangler configuration is generated from the profile into
the package, as `wrangler.json`.

## Deploy

Run the **Deploy Pages** workflow (`.github/workflows/deploy-pages.yml`) from
the Actions tab. It only runs by hand. It takes a profile and a `deploy` box.
With the box unticked, the run builds the package, uploads it as an artifact
and stops after `wrangler deploy --dry-run`. With it ticked, the run also
deploys, then checks that `/health` reports the build id it built.

The workflow has two jobs, so that another repository's install and build
scripts never run in a job that holds the Cloudflare token:

1. `build` runs `scripts/stage.mjs`. It fetches the commit named in
   `source.json` and, in `apps/pages`, runs `npm ci`, `npm run setup`,
   `npm run build:upstream`, `npm run build` and
   `scripts/cloudflare-stage.mjs` with the profile. `npm run setup` also
   fetches `automerge/automerge-repo` at a commit the Pages source pins. This
   job holds no secret.
2. `deploy` installs Wrangler from this repository's lockfile. It runs
   `scripts/check-package.mjs` first: the package's `wrangler.json` may hold
   no field that runs a command, and no Worker, account, route, database or
   bucket other than the profile's. Its migrations may only add Durable
   Object classes, and the package may hold only the files the packaging
   script writes, with no symlink. Then it runs
   `wrangler deploy --config PACKAGE/wrangler.json` with
   `CLOUDFLARE_API_TOKEN`, the repository secret the other Workers deploy
   with.

To deploy a newer Pages, change `commit` in `source.json` in a pull request,
merge it, then run the workflow. The build id is a hash of the Pages source,
so one commit always reports one id.

The same steps by hand, from this folder, with Node 22 or newer. Only the
last command needs `wrangler login` or `CLOUDFLARE_API_TOKEN`:

```sh
pnpm install --filter '{.}...'
pnpm run stage dev NEW_DIRECTORY
pnpm run check-package dev NEW_DIRECTORY
pnpm exec wrangler deploy --dry-run --config NEW_DIRECTORY/wrangler.json
pnpm exec wrangler deploy --config NEW_DIRECTORY/wrangler.json
```

`NEW_DIRECTORY` must not exist yet. The stage step prints the Worker name, the
commit and the build id.

A second deployment needs its two D1 databases and its R2 bucket created
first, then a profile here beside `dev.json`, and its name added to the
workflow's `profile` options.

## Secrets

No secret is in this repository, in a profile or in the package. The
packaging script refuses a profile variable whose name reads like one.

| Name | Where it is set | Use |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Repository secret, read by the `deploy` job only | Publishes the Worker |
| `NOTEBOOK_CLOUD_APP_SESSION_KEYS` | Worker secret on `pages-dev` | Session keyring |
| `PAGES_KILO_EXCHANGE_SECRET` | Worker secret on `pages-dev` | Sign-in handoff with the web app |
| `PAGES_DEV_AUTH_SECRET` | The web app's Vercel environment | The same value as `PAGES_KILO_EXCHANGE_SECRET` |

`wrangler deploy` keeps the secrets already on the Worker, so the workflow
never reads or writes them. Set or rotate one with
`wrangler secret put NAME --name pages-dev`.

## Roll back

```sh
pnpm exec wrangler rollback --name pages-dev
```

This puts the previous version back at once, with no build. Then revert the
`source.json` change, so the pin names what is running. To go back further,
set `commit` to the older commit and run the workflow.

A rollback changes code only:

- Durable Object, D1 and R2 data stay as the newer version left them. A
  release that changes stored data cannot be undone this way. The dev
  deployment's data is disposable: empty it and deploy again.
- Cloudflare refuses a rollback to a version from before a Durable Object
  migration. `scripts/check-package.mjs` lets a migration add classes only: a
  release that deletes or renames one changes that script in the pull request
  that moves the pin.
- A version runs with the secret values it was deployed with. Before a
  rollback across a secret rotation, read "Session key rotation" in nteract's
  `apps/pages/DEPLOYMENT.md`.

## Dev deployment

|  |  |
|---|---|
| Worker | `pages-dev` |
| Address | `https://pages-dev.kiloapps.io` |
| First deployed | 2026-11-10, from `nteract/nteract` at `3c22117f7`, version `e11cd161-d009-4619-8cdb-b8464a0a17a1` |
| Running now | `nteract/nteract` main at `dc13616ff`, version `1c61b180-4245-4a95-8e37-f7b6e04817a2` |
| Build id | `c28f065c4e19` (reported by `/health`) |
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

The deployment has no API keys. A bearer that Pages did not issue gets 401
`api_keys_unsupported`, and the Worker makes no outbound request for it. The
profile still carries the two `NOTEBOOK_CLOUD_ANACONDA_API_KEY_*` values; with
`PAGES_KILO_APP_URL` set nothing reads them, and they can leave the profile.

Before `dc13616ff` the Worker sent any unknown bearer to the Anaconda account
service to check it. A Kilo credential sent to this address before then should
be rotated.

The address is public. Anyone with a Kilo account can sign in. Treat its data
as disposable.

## Which agents can connect

The Worker is its own OAuth server for `/mcp`. A person signs in with their
Kilo account and approves a consent page; the client gets a Pages token, never
a Kilo one.

`PAGES_OAUTH_ANY_CLIENT_DOCUMENT` is not set in the profile, so the Worker
reads a client ID metadata document only for the clients it names: Claude
(web, desktop and mobile), Claude Code and ChatGPT. The Kilo CLI connects with
its fixed id, `pages-kilo`. Any other client is refused before anything is
fetched. Setting the variable to `true` admits any client that publishes a
document; read "Outbound requests" in nteract's `apps/pages/DEPLOYMENT.md`
before turning it on.

Checked signed out on 2026-11-10: the authorize page answers "Connect an
app" for both Claude client ids and "Connect Kilo" for the Kilo CLI, and 400
for a document on another site.

Connected on 2026-11-10: Claude, as a custom connector with its default
settings, and the Kilo CLI with `pages-kilo`. Both act as the Kilo account
that approved them.

`/llms.txt` and `/connect` describe these routes and nothing else. They are
written by the Worker for a deployment with `PAGES_KILO_APP_URL` set.

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

## Checked after the guide change

On 2026-11-10, at `dc13616ff`:

- A person signed in with a Kilo account in the browser.
- `/llms.txt` opens with "This deployment signs people and agents in with Kilo
  accounts and has no API keys", and names no other provider.
- A request with a made-up bearer to `/whoami` answers 401
  `api_keys_unsupported`. A request with no credential to `/api/tools` answers
  401 `auth_required` and points to `/connect`.
- The Claude connector approved earlier still lists Pages after the deploy.

## Not checked yet

- A run of the Deploy Pages workflow. Every deploy so far was made by hand. The
  package `scripts/stage.mjs` builds from `dc13616ff` has the build id the
  dev Worker reports, and passes `wrangler deploy --dry-run` with this
  repository's Wrangler. Whether `CLOUDFLARE_API_TOKEN` may deploy this Worker
  with its D1, R2 and custom domain is not known until the first run.
- A second browser failing to finish a sign-in link the first one started.
- A session ending at 8 hours.
- Sharing a Page between two Kilo accounts. Invitations match a verified
  email, and Kilo accounts carry none, so this is expected not to work yet.
- Live sync over WebSocket between two clients.
- Image import from a ChatGPT attachment.
- Memory limits, hibernation and cold-start time. The limits in this build are
  sized for a large single host, not for Workers.
