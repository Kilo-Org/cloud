# Pages

Shared documents that people and agents edit together. One Cloudflare Worker
serves the editor, the HTTP API and an MCP server, and people sign in with
their Kilo accounts.

Pages source lives in `nteract/nteract`, directory `apps/pages`. This folder
holds what this repository decides about a deployment: which commit is built,
which Worker and resources it runs on, and how it is deployed.

## Architecture

```
services/pages/source.json   → pinned commit of nteract/nteract
services/pages/profiles/*.json → Worker name, account, hostname, D1, R2, variables
  → scripts/stage.mjs (fetch, build, package with a generated wrangler.json)
  → scripts/check-package.mjs (the package may name only what the profile names)
  → wrangler deploy
```

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

## Environments

| | Dev |
|---|---|
| Profile | `profiles/dev.json` |
| Worker | `pages-dev` |
| Address | `https://pages-dev.kiloapps.io` |
| D1, auth and catalog | `pages-dev-auth` |
| D1, usage | `pages-dev-usage` |
| R2 | `pages-dev-assets` |
| Durable Objects | `Page`, `Catalog`, `PageRecords`, `Space` (SQLite classes) |
| Cron triggers | `5 0 * * *`, `35 * * * *` |

The address is public and anyone with a Kilo account can sign in. Treat the
dev deployment's data as disposable.

`pages-dev.kiloapps.io` is a Workers custom domain on the `kiloapps.io` zone.
It is the Worker's only address: the profile has `workers_dev: false`, because
the Worker checks every request against one origin. The profile names the
hostname and its zone under `custom_domain`, and the package carries that as
its route. Do not use `wrangler deploy --domain`: it cannot name the zone, and
the API answers "Can't infer zone from route".

## Authentication

People sign in with Kilo accounts, through the web app. `/api/auth/login`
sends the browser to `/pages-auth` on `PAGES_KILO_APP_URL` with this
deployment's origin and a one-time `state`. Kilo sends it back to
`/api/auth/kilo/callback` with a code, and the Worker trades the code at
`/api/pages-auth/exchange` for the account's id, name and organizations. Pages
holds no Kilo token. A session lasts 8 hours and is not renewed: the browser
goes through Kilo again. The account is named `user:kilo:<id>`.

The deployment has no API keys. A bearer that Pages did not issue gets 401
`api_keys_unsupported`, and the Worker makes no outbound request for it.

Sharing by email invitation does not work here: an invitation matches a
verified email, and Kilo accounts carry none.

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

### By hand

From this folder, with Node 22 or newer. Only the last command needs
`wrangler login` or `CLOUDFLARE_API_TOKEN`:

```bash
pnpm install --filter '{.}...'
pnpm run stage dev NEW_DIRECTORY
pnpm run check-package dev NEW_DIRECTORY
pnpm exec wrangler deploy --dry-run --config NEW_DIRECTORY/wrangler.json
pnpm exec wrangler deploy --config NEW_DIRECTORY/wrangler.json
```

`NEW_DIRECTORY` must not exist yet. The stage step prints the Worker name, the
commit and the build id.

### Another deployment

Create its two D1 databases and its R2 bucket first. Then add a profile beside
`dev.json`, and its name to the workflow's `profile` options.

### Rollback

```bash
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

## Secrets

No secret is in this repository, in a profile or in the package. The
packaging script refuses a profile variable whose name reads like one.

| Secret | Where it is set | Description |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Repository secret, read by the `deploy` job only | Publishes the Worker |
| `NOTEBOOK_CLOUD_APP_SESSION_KEYS` | Worker secret on `pages-dev` | Session keyring |
| `PAGES_KILO_EXCHANGE_SECRET` | Worker secret on `pages-dev` | Sign-in handoff with the web app |
| `PAGES_DEV_AUTH_SECRET` | The web app's Vercel environment (`pnpm web:env set`) | The same value as `PAGES_KILO_EXCHANGE_SECRET` |

`wrangler deploy` keeps the secrets already on the Worker, so the workflow
never reads or writes them. Set or rotate one with
`wrangler secret put NAME --name pages-dev`.

To rotate the exchange secret, set a new value in both places. Until both
match, sign-in fails and nothing else changes.

Workers secrets are write-only. The only readable copy of the session keyring
is on the machine that made the first deploy; it belongs in the team secret
store before anyone else needs to rotate it. Losing it only signs browser
sessions out: a new keyring can replace it.

## Environment Variables

Plain variables, set in the profile's `vars`.

| Variable | Description |
|---|---|
| `NOTEBOOK_CLOUD_PUBLIC_ORIGIN` | The Worker's public origin. Links, the MCP metadata and browser origin checks all use it |
| `PAGES_KILO_APP_URL` | The Kilo web app that signs people in. Setting it turns on Kilo sign-in and turns API keys off |
| `PAGES_DEFAULT_PAGE_QUOTA` | How many active Pages one account may hold |
| `PAGES_CATALOG_INDEX` | Epoch label of the D1 catalog index |
| `NOTEBOOK_CLOUD_ANACONDA_API_KEY_*` | Not read while `PAGES_KILO_APP_URL` is set |
