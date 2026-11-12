# Pages

Shared documents that people and agents edit together. One Cloudflare Worker
serves the editor, the HTTP API and an MCP server, and people sign in with
their Kilo accounts.

Pages source lives in `nteract/nteract`, directory `apps/pages`. nteract
builds it and publishes each build as a release asset. This folder holds what
this repository decides about a deployment: which release is deployed, and the
Worker's Wrangler configuration. No nteract code runs here.

## Architecture

```
source.json → nteract release pages-<build_id> + sha256 of its archive
  → pnpm run build (download, check sha256, read archive, compare configurations)
  → dist/worker (Worker module + WASM), dist/public (browser assets)
wrangler.jsonc → wrangler deploy
```

| File | Holds |
|---|---|
| `source.json` | The release tag and the sha256 of its archive |
| `wrangler.jsonc` | What deploys: the Worker's name, route, bindings, migrations, cron triggers and variables |
| `scripts/build.mjs` | Downloads the pinned archive, checks it, and fills `dist/` |
| `scripts/pin.mjs` | Moves the pin to a release, after checking its attestation |
| `scripts/package.mjs` | The checks on the archive and its configuration |

A Pages package ships a deployment-neutral `wrangler.json`: the fields the code
fixes (Durable Object classes, migrations, cron triggers, asset handling,
compatibility date, `NOTEBOOK_CLOUD_OIDC_FLOW`), with no name, route, database,
bucket or other variable. The build compares those fields with `wrangler.jsonc`
and fails on any difference, naming the fields. So a release that adds a
Durable Object class, a migration or a cron trigger changes `wrangler.jsonc` in
the pull request that moves the pin, where it is reviewed.

The build reads the archive as untrusted input. It accepts regular files at
the package's paths only: no links, no directory entries, no `.` or `..`
components, no file outside `worker/`, `public/`, `build-receipt.json` and
`wrangler.json`.

## Environments

| | Dev |
|---|---|
| Worker | `pages-dev` |
| Address | `https://pages-dev.kiloapps.io` |
| D1, auth and catalog | `pages-dev-auth` |
| D1, usage | `pages-dev-usage` |
| R2 | `pages-dev-assets` |
| Durable Objects | `Page`, `Catalog`, `PageRecords`, `Space` (SQLite classes) |
| Cron triggers | `5 0 * * *`, `35 * * * *` |

The address is public and anyone with a Kilo account can sign in. People keep
real work on `pages-dev`. A deploy may change its code, but never reset, delete
or recreate the Worker, its D1 databases, its R2 bucket or the documents its
Durable Objects hold.

`pages-dev.kiloapps.io` is a Workers custom domain on the `kiloapps.io` zone.
It is the Worker's only address: `workers_dev` is `false`, because
the Worker checks every request against one origin. The route names its zone:
without `zone_name` the API can answer "Can't infer zone from route".

There is one Worker, so `pages-dev` is the base configuration and
`deploy-workers.yml` deploys it as its `production` target. There is no
`env.staging`, so the staging pipeline skips Pages.

## Authentication

People sign in with Kilo accounts, through the web app. `/api/auth/login`
sends the browser to `/pages-auth` on `PAGES_KILO_APP_URL` with this
deployment's audience, `pages-dev`, and a one-time `state`. The web app looks
up the deployment's address from the audience and sends the browser back to
`/api/auth/kilo/callback` there with a code. The Worker trades the code at
`/api/pages-auth/exchange` for the account's id, name and organizations. Pages
holds no Kilo token. A session lasts 8 hours and is not renewed: the browser
goes through Kilo again. The account is named `user:kilo:<id>`.

The deployment has no API keys. A bearer that Pages did not issue gets 401
`api_keys_unsupported`, and the Worker makes no outbound request for it.

An email invitation is claimed with a verified address. The exchange answers
with `user.verified_email` only when the account's sign-in method proves the
address; without it, the person cannot accept an invitation.

A Page or a Project can be shared with a Kilo organization its owner belongs
to. Pages records the organizations from each exchange in the `kilo_memberships`
table of the `DB` database, which the Worker creates when it first needs it.

### Agents

The Worker is its own OAuth server for `/mcp`. A person signs in with their
Kilo account and approves a consent page. The client gets a Pages token, never
a Kilo one.

| Client | Admitted by |
|---|---|
| Claude (web, desktop and mobile), Claude Code, ChatGPT | Client ID metadata document, for the clients the Worker names |
| Kilo CLI | Its fixed client id, `pages-kilo` |
| Any other client | Refused before anything is fetched |

Setting `PAGES_OAUTH_ANY_CLIENT_DOCUMENT` to `true` admits any client that
publishes a document. Read "Outbound requests" in nteract's
`apps/pages/DEPLOYMENT.md` before turning it on.

`/llms.txt` and `/connect` describe these routes to agents and to people.

## API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/health` | GET | None | Health check. Reports the build id as `build` |
| `/api/auth/login` | GET | None | Starts sign-in through the Kilo web app |
| `/mcp` | POST | Pages OAuth token | MCP server |
| `/api/tools` | POST | Signed in | The same tools over HTTP |
| `/connect`, `/llms.txt` | GET | None | How to connect an agent |

"HTTP and MCP tools" in the Pages source's `REFERENCE.md` describes the tools.

## Deployment

Deployed by `deploy-workers.yml`, like the other Workers. It finds this folder
by its `wrangler.jsonc`, runs `predeploy` (`pnpm run build`), then
`wrangler deploy`. A merge to `main` that changes this folder, or a workspace
it depends on, deploys `pages-dev`. Nothing else deploys it: no Wrangler
deploy from a laptop.

A deploy is a pull request that moves the pin. Run the "Pages package release"
workflow in nteract for the commit you want, then pin its release here:

```bash
pnpm run pin pages-<build_id>
```

`pin` downloads the archive with `gh`, checks it against the release's digest
file, and runs `gh attestation verify` against nteract's release workflow
before it writes `source.json`. The deploy job checks only the sha256, so the
pin is where the archive's origin is checked. Link the nteract compare range in
the pull request. If the build reports that `wrangler.jsonc` differs, change it
in the same pull request. `/health` reports the build id as `build`.

### Development

From this folder, with Node 22 or newer:

```bash
pnpm install --filter '{.}...'
pnpm run build
pnpm exec wrangler deploy --dry-run
```

```bash
pnpm test
pnpm typecheck
```

`pnpm run build -- --archive FILE` reads an archive built by nteract's
`scripts/release-package.mjs` instead of downloading one; the digest check
still applies. There is no `wrangler dev` here. Run Pages locally from its own
repository.

### Rollback

```bash
pnpm exec wrangler rollback --name pages-dev
```

This puts the previous version back at once, with no build. Then revert the
`source.json` change, or the next deploy puts the newer build back.

A rollback changes code only:

- Durable Object, D1 and R2 data stay as the newer version left them. A
  release that changes stored data cannot be undone this way, and the older
  code has to read what the newer one wrote. `build-receipt.json` lists the
  document formats a build reads and writes; when a bump changes them, say in
  the pull request whether the previous build can still open the documents.
  The data is people's work: there is no "empty it and deploy again".
- Cloudflare refuses a rollback to a version from before a Durable Object
  migration.
- A version runs with the secret values it was deployed with. Before a
  rollback across a secret rotation, read "Session key rotation" in nteract's
  `apps/pages/DEPLOYMENT.md`.

## Secrets

No secret is in this repository.

| Secret | Where it is set | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Repository secret, read by `deploy-workers.yml` | Publishes the Worker |
| `NOTEBOOK_CLOUD_APP_SESSION_KEYS` | Worker secret on `pages-dev` | Session keyring |
| `PAGES_KILO_EXCHANGE_SECRET` | Worker secret on `pages-dev` | Sign-in handoff with the web app |
| `PAGES_DEV_AUTH_SECRET` | The web app's Vercel environment (`pnpm web:env set`) | The same value as `PAGES_KILO_EXCHANGE_SECRET` |

`wrangler deploy` keeps the secrets already on the Worker, so a deploy never
reads or writes them. Set or rotate one with
`wrangler secret put NAME --name pages-dev`.

To rotate the exchange secret, set a new value in both places. Until both
match, sign-in fails and nothing else changes.

Workers secrets are write-only. The only readable copy of the session keyring
is on the machine that made the first deploy; it belongs in the team secret
store before anyone else needs to rotate it. Losing it only signs browser
sessions out: a new keyring can replace it.

## Environment Variables

Plain variables, set in `vars` in `wrangler.jsonc`.

| Variable | Description |
|---|---|
| `NOTEBOOK_CLOUD_PUBLIC_ORIGIN` | The Worker's public origin. Links, the MCP metadata and browser origin checks all use it |
| `PAGES_KILO_APP_URL` | The Kilo web app that signs people in. Setting it turns on Kilo sign-in and turns API keys off |
| `PAGES_KILO_AUDIENCE` | The name the web app holds this deployment under. Sign-in fails unless it is an audience in the web app's `pages-auth-clients.ts` |
| `PAGES_DEFAULT_PAGE_QUOTA` | How many active Pages one account may hold |
| `PAGES_CATALOG_INDEX` | Epoch label of the D1 catalog index |
| `NOTEBOOK_CLOUD_OIDC_FLOW` | `server`. Structural: the package names it, and the build checks it |
| `NOTEBOOK_CLOUD_ANACONDA_API_KEY_*` | Not read while `PAGES_KILO_APP_URL` is set |
