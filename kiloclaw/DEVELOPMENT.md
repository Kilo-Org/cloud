# KiloClaw Development Guide

## Prerequisites

- Node.js 22+
- pnpm
- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5/month) -- required for Cloudflare Sandbox containers
- [Containers enabled](https://dash.cloudflare.com/?to=/:account/workers/containers) on your account
- [Fly CLI](https://fly.io/docs/flyctl/install/) (`fly`)
- Docker (for building/pushing images)
- Access to the **Kilo (dev)** Fly org (accept the invite from your email)
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or [ngrok](https://ngrok.com/) (so remote Fly machines can call back to your local Next.js)

Install `cloudflared` (separate from Wrangler) via Homebrew:

```bash
brew install cloudflared
```

## How It Fits Together

KiloClaw is a Cloudflare Worker that manages per-user OpenClaw instances on
Fly.io Machines. In local dev there are three moving pieces:

1. **Next.js app** (`localhost:3000`) -- the dashboard and platform API.
   Provisions/starts/stops instances by calling the worker's internal API.
   Also acts as your local Kilo gateway for model requests.
2. **KiloClaw worker** (`localhost:8795`) -- `wrangler dev`. The control plane.
   Orchestrates provisioning on Fly, proxies browser traffic to machines.
3. **Fly Machines** (remote) -- the actual OpenClaw instances. They call
   back to your Next.js app (via a tunnel) for model requests.

Because Fly machines are remote, they can't reach `localhost:3000` directly.
You need a tunnel so that `KILOCODE_API_BASE_URL` resolves to your local
Next.js from the internet.

### How Fly provisioning works

Fly provisions the **volume before the machine**. Volumes are NVMe block
storage pinned to a specific region. After the volume is created, the machine
must land on a host that has room for it.

Between volume creation and machine creation, another user can claim the
host's remaining resources ("capacity sniping"). This surfaces as an "out of
capacity" error. Retrying `start` usually resolves it.

### Fly app per customer

There is a **Dockerfile** in the `kiloclaw/` directory. KiloClaw creates one
Fly app per customer (e.g., `dev-{hash}` in development). All per-customer
machines pull Docker images from a shared registry app. Fly lets you use one
app as a kind of image registry for all other apps -- in dev, that app is
`kiloclaw-dev` (set via `FLY_REGISTRY_APP`).

## Fly.io Org Setup

1. Accept the Fly.io org invite(s) from your email (there should be two --
   check spam if you only see one).
2. Verify with `fly orgs list` -- the dev org should appear.
3. Log in to the Fly CLI: `fly auth login`

The dev-start script creates and refreshes Fly API tokens automatically -- you
don't need to manage tokens manually.

## Quick Start

One-time prerequisites:

1. Link the Vercel project (from monorepo root): `vercel link`
2. Accept Fly.io org invites and `fly auth login` (see above)

Then, from the `kiloclaw/` directory:

```bash
./scripts/dev-start.sh
```

The script handles everything: creates `.dev.vars` if missing, pulls Vercel
env, syncs secrets, validates/refreshes the Fly token, installs dependencies,
starts the database, runs migrations, starts a Cloudflare tunnel (and captures
the URL into `.dev.vars`), and launches all three processes.

Open <http://localhost:3000> to use the dashboard.

### Display modes

Control how the three processes are displayed with `--display <mode>`:

| Mode    | Description                                                           |
| ------- | --------------------------------------------------------------------- |
| `tabs`  | Separate terminal tabs (default; auto-detects iTerm2 vs Terminal.app) |
| `split` | Single tab with split panes (requires iTerm2)                         |
| `tmux`  | tmux session `kiloclaw` (attach with `tmux attach -t kiloclaw`)       |

### Other flags

| Flag                       | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `--has-controller-changes` | Build and push a new Docker image before starting    |
| `--tunnel-name <name>`     | Use a named Cloudflare tunnel instead of a quick one |

### Script configuration

Save defaults in a config file so you don't need to pass flags every time.
The script checks two locations (project-local overrides user-global):

| Location                            | Scope                       |
| ----------------------------------- | --------------------------- |
| `kiloclaw/scripts/.dev-start.conf`  | Per-worktree (gitignored)   |
| `~/.config/kiloclaw/dev-start.conf` | Shared across all worktrees |

See `scripts/.dev-start.conf.example` for available options. CLI flags
override config file values.

### Manual quick start (without dev-start.sh)

```bash
# Install dependencies (run from monorepo root)
pnpm install

# Copy the example env file
cp .dev.vars.example .dev.vars

# Edit .dev.vars -- add any required secrets
# See "Environment Variables" below for details

# Run the dev server
pnpm start
```

`pnpm start` runs `wrangler dev`, which builds the worker and starts a local dev server.
The first request will pull the container image and cold-start it (1-2 minutes).

## Tunnel Setup

The dev-start script automatically starts a Cloudflare quick tunnel, captures
its URL, and writes `KILOCODE_API_BASE_URL` into `.dev.vars`. You generally
don't need to manage this manually.

### Free vs named tunnels

- **Free quick tunnel** (default): hostname changes on every restart. The
  script handles this automatically.
- **Named tunnel**: preconfigure in the Cloudflare dashboard for a persistent
  hostname (e.g., `yourname.devclaw.dev`). Use `--tunnel-name <name>` or set
  `TUNNEL_NAME` and `TUNNEL_HOSTNAME` in your config file.

### If the tunnel isn't working

The error manifests in OpenClaw as one of:

1. Three dots (`...`) appear, then **nothing happens** (silent failure), OR
2. OpenClaw says **"models require authentication"**

If you see either, check:

- `cloudflared` is running (check its terminal tab/window)
- `KILOCODE_API_BASE_URL` in `.dev.vars` matches the current tunnel URL
- The KiloClaw worker was restarted after changing `.dev.vars`

## Commands

```bash
pnpm start            # wrangler dev (local development)
pnpm run dev          # alias for wrangler dev
pnpm typecheck        # tsgo --noEmit
pnpm lint             # oxlint
pnpm format           # oxfmt
pnpm format:check     # oxfmt --list-different
pnpm test             # vitest run
pnpm test:watch       # vitest (watch mode)
pnpm test:coverage    # vitest --coverage
pnpm types            # regenerate worker-configuration.d.ts
pnpm deploy           # wrangler deploy
```

Run `pnpm types` after changing `wrangler.jsonc` to regenerate the TypeScript
binding types.

## Environment Variables

All secrets are configured in `.dev.vars` for local development and via
`wrangler secret put` for production.

The dev-start script creates `.dev.vars` from `.dev.vars.example` on first run
and automatically manages several values. The tables below show which variables
are auto-managed and which require manual setup.

### Auth (required)

| Variable               | Description                                                                                                                          | How to generate        | Source  | Auto-managed |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------- | ------------ |
| `NEXTAUTH_SECRET`      | JWT signing key (HS256). Must match the Next.js app's secret.                                                                        | `openssl rand -hex 32` | Vercel  | Yes          |
| `INTERNAL_API_SECRET`  | Shared key for platform API routes (`x-internal-api-key` header). Must match Next.js `KILOCLAW_INTERNAL_API_SECRET`.                 | `openssl rand -hex 32` | Vercel  | Yes          |
| `GATEWAY_TOKEN_SECRET` | HMAC key for per-sandbox gateway tokens. Worker-only (Next.js reads derived tokens from the API). Can be any arbitrary value in dev. | `openssl rand -hex 32` | Example | No           |

For local dev, any placeholder values work (the example file has defaults).
For production, generate real secrets and keep `NEXTAUTH_SECRET` and
`INTERNAL_API_SECRET` in sync with the Next.js deployment.

### AI Provider (required)

KiloClaw uses the KiloCode provider only.

| Variable           | Description                                                                |
| ------------------ | -------------------------------------------------------------------------- |
| `KILOCODE_API_KEY` | Per-instance KiloCode API key (injected by Next.js during provision/patch) |

### Fly.io

| Variable           | Description                                                                             | Source       | Auto-managed |
| ------------------ | --------------------------------------------------------------------------------------- | ------------ | ------------ |
| `FLY_API_TOKEN`    | Fly org token                                                                           | dev-start.sh | Yes          |
| `FLY_ORG_SLUG`     | Fly org slug (read by script for token creation)                                        | Example      | No           |
| `FLY_REGISTRY_APP` | Shared Fly app that holds Docker images (e.g., `kiloclaw-dev`)                          | Example      | No           |
| `FLY_APP_NAME`     | Legacy fallback app name for existing instances (may be removed in future)              | Example      | No           |
| `FLY_REGION`       | Region priority list, e.g. `us,eu`. Tries US first, falls back to EU, then gives up.    | Example      | No           |
| `FLY_IMAGE_TAG`    | Docker image tag. Set automatically by `scripts/push-dev.sh`, or use `latest` to start. | push-dev.sh  | Yes          |
| `FLY_IMAGE_DIGEST` | Docker image digest. Set automatically by `scripts/push-dev.sh`.                        | push-dev.sh  | Yes          |
| `OPENCLAW_VERSION` | OpenClaw version in the image. Set automatically by `scripts/push-dev.sh`.              | push-dev.sh  | Yes          |

`FLY_IMAGE_TAG`, `FLY_IMAGE_DIGEST`, and `OPENCLAW_VERSION` together control
what version gets deployed by default for your dev instances. The build script
auto-updates all three. For initial setup, ask a team member for known-working
values or use `latest` (if a `latest` tag exists in the registry).

### Tunnel / API

| Variable                | Description                       | Source       | Auto-managed |
| ----------------------- | --------------------------------- | ------------ | ------------ |
| `KILOCODE_API_BASE_URL` | Your tunnel URL + `/api/gateway/` | dev-start.sh | Yes          |

### R2 Persistence

Without these, container data is ephemeral (lost on restart). R2 mounting only
works in production -- `wrangler dev` does not support s3fs mounts.

| Variable               | Description                                 |
| ---------------------- | ------------------------------------------- |
| `R2_ACCESS_KEY_ID`     | R2 S3-compatible access key                 |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret key                 |
| `CF_ACCOUNT_ID`        | Cloudflare account ID (for R2 endpoint URL) |

To create R2 API credentials:

1. Go to **R2 > Overview** in the [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Click **Manage R2 API Tokens**
3. Create a token with **Object Read & Write** permissions on the `kiloclaw-data` bucket
4. Copy the Access Key ID and Secret Access Key

### Encryption

Required for decrypting user-provided secrets (BYOK API keys, channel tokens).

| Variable                     | Description                                                                                                                                                                                             | Source    | Auto-managed |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------ |
| `AGENT_ENV_VARS_PRIVATE_KEY` | RSA private key (PEM). Get the **dev** version from 1Password (engineering vault). Quote the value in `.dev.vars`. The matching public key lives in the Next.js backend as `AGENT_ENV_VARS_PUBLIC_KEY`. | 1Password | No           |

The Next.js app encrypts user secrets with the public key before sending them to
the worker. The worker decrypts them at container startup. Without this key,
user-provided encrypted secrets and channel tokens are silently skipped.

### Development Flags

| Variable     | Description                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WORKER_ENV` | Defaults to `"production"` in `wrangler.jsonc`. **Set to `"development"` in `.dev.vars` for local dev** so JWT `env` claims match and Fly app names use the `dev-` prefix instead of `acct-`. Leave it unset in production unless you intentionally need a different override. |

### Optional

| Variable                   | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `KILOCODE_API_BASE_URL`    | Override KiloCode API base URL (dev only)          |
| `CDP_SECRET`               | Shared secret for CDP browser automation endpoints |
| `WORKER_URL`               | Public URL of the worker (required for CDP)        |
| `OPENCLAW_ALLOWED_ORIGINS` | Comma-separated origins for WebSocket connections  |

### `.env.local` (Next.js, monorepo root)

The Next.js app also needs these two variables to talk to the KiloClaw worker.
Both are included in `vercel env pull` (run automatically by the dev-start
script):

| Variable                       | Description                                     |
| ------------------------------ | ----------------------------------------------- |
| `KILOCLAW_API_URL`             | Worker URL, e.g. `http://localhost:8795`        |
| `KILOCLAW_INTERNAL_API_SECRET` | Must match `INTERNAL_API_SECRET` in `.dev.vars` |

## Wrangler Bindings

These are configured in `wrangler.jsonc`, not as secrets:

| Binding             | Type           | Description                                                   |
| ------------------- | -------------- | ------------------------------------------------------------- |
| `Sandbox`           | Durable Object | `KiloClawSandbox` -- container lifecycle management           |
| `KILOCLAW_INSTANCE` | Durable Object | `KiloClawInstance` -- per-user instance state, config, alarms |
| `KILOCLAW_BUCKET`   | R2 Bucket      | `kiloclaw-data` -- persistent storage                         |
| `HYPERDRIVE`        | Hyperdrive     | Postgres connection for pepper validation + instance registry |

## Building and Pushing Images

Provisioning requires a Docker image in the Fly registry. For initial setup,
existing images from a team member are usually sufficient. Run `push-dev.sh`
when changing the Docker image, OpenClaw startup behavior, or the Node
controller (e.g., adding new `/_kilo/` routes).

### Docker authentication

```bash
# Run before each push — the token expires after 5 minutes
fly auth docker
```

If the push takes longer than 5 minutes (e.g., due to low upload bandwidth),
the token expires mid-push and Fly returns an error saying it "doesn't
recognize the app." Workarounds:

- Push from a machine with decent upload speed
- Use an org token directly instead of `fly auth docker`

### `scripts/push-dev.sh`

Run from the `kiloclaw/` directory:

```bash
./scripts/push-dev.sh
```

This will:

1. Build the Docker image for `linux/amd64`
2. Push it to `registry.fly.io/{app}:{tag}`, where `{app}` is read from
   `FLY_APP_NAME` in `.dev.vars` (falling back to `kiloclaw-dev` if unset).
   This must match `FLY_REGISTRY_APP` or new instances won't find the image.
3. Auto-update `FLY_IMAGE_TAG`, `FLY_IMAGE_DIGEST`, and `OPENCLAW_VERSION` in `.dev.vars`

Each push creates a unique tag (`dev-<timestamp>`) and only updates your local
`.dev.vars`. Other developers' machines are unaffected — they keep running
whatever `FLY_IMAGE_TAG` is in their own `.dev.vars`.

The image is large, so pushes are slow. After pushing, restart the worker
(`pnpm run dev`) to pick up the new values, then restart your instance from the
dashboard. A restart is sufficient to pick up the new image — you only need to
destroy and re-provision if the volume or Fly app config changed.

### When do I need to push a new image?

The Docker image bundles the **Node controller** (`controller/src/`) and
**OpenClaw**. The KiloClaw **worker** (`src/`) runs on Cloudflare and does NOT
require an image push — `pnpm run dev` picks up worker changes immediately.

Push a new image when you change:

- Controller routes or logic (`controller/src/`)
- The Dockerfile or startup scripts
- OpenClaw version (pinned in the Dockerfile)

**Symptom of a stale controller image:** the worker calls a new `/_kilo/` route
that exists in your local controller code but not in the deployed image. The
request falls through to the proxy, which returns a bare `401 Unauthorized`
instead of the expected `controller_route_unavailable` code. This surfaces as a
`GatewayControllerError: Unauthorized` in the worker logs.

## Testing a Custom OpenClaw Build

To test a local OpenClaw fork (e.g., a feature branch with embeddings support),
use `Dockerfile.local` which installs OpenClaw from a tarball in `openclaw-build/`
instead of npm.

### 1. Build and pack your fork

```bash
cd /path/to/openclaw
pnpm build && npm pack
```

This produces a file like `openclaw-2026.3.9.tgz` in the repo root.

### 2. Copy the tarball

```bash
cp /path/to/openclaw/openclaw-*.tgz kiloclaw/openclaw-build/
```

The `openclaw-build/` directory is git-ignored for `.tgz` files, so tarballs
won't be committed.

### 3. Build and push with `--local`

```bash
# From kiloclaw/
./scripts/push-dev.sh --local
```

This uses `Dockerfile.local` instead of the default `Dockerfile`. The script
validates that a tarball exists in `openclaw-build/` before building. Everything
else (tagging, pushing, `.dev.vars` updates) works the same as a normal push.

### 4. Deploy

1. Restart the KiloClaw worker: `pnpm run dev`
2. From the dashboard (`localhost:3000`), destroy your existing instance
   (Settings tab → Destroy), then create/provision a new one.
3. The new instance will run your custom OpenClaw build.

### Notes

- `OPENCLAW_VERSION` in `.dev.vars` is extracted from the main `Dockerfile`'s
  pinned npm version, so it won't reflect your fork's version. This is cosmetic.
- Clean up old tarballs from `openclaw-build/` before copying a new one --
  the `COPY openclaw-build/openclaw-*.tgz` glob must match exactly one file.
- Remember to `fly auth docker` before pushing (token expires after 5 minutes).

## Provisioning and Using an Instance

### From the dashboard (`localhost:3000`):

1. Select a model.
2. Click **Create / Provision**.
3. Optionally set up a channel (takes longer).
4. Watch it provision in the worker terminal logs.

### If provisioning fails

- **"tag latest unknown manifest"** -- the image tag doesn't exist in the
  registry. Get known-working image values from a team member, update
  `.dev.vars`, restart the worker, then destroy (Settings tab → Destroy) and
  re-provision.
- **"out of capacity"** -- Fly couldn't find a host with room. Retry `start`;
  it usually works on the next attempt.
- After updating image tags in `.dev.vars`, restart the worker and destroy the
  existing instance before re-provisioning.

### Accessing OpenClaw

Once the gateway is up (check the worker logs), click **Open** in the
dashboard. The traffic flow is:

```
Browser → local KiloClaw worker → remote Fly machine controller → OpenClaw gateway
```

Type a message (e.g., "hello") to verify end-to-end connectivity. Note that
"gateway" in the Fly machine logs refers to the OpenClaw gateway, not the
Kilo gateway.

### Local dev without browser auth

To test the full flow locally without browser auth,
use the platform API routes to provision and start an instance:

```bash
# Read the real platform API secret from .dev.vars instead of hardcoding a sample.
# This keeps examples aligned with your local setup and avoids copying placeholder secrets into shell history.
export API_KEY="$(grep '^INTERNAL_API_SECRET=' .dev.vars | cut -d= -f2-)"

# Provision an instance (replace with a test user ID)
curl -X POST http://localhost:8795/api/platform/provision \
  -H "x-internal-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user-123"}'

# Start it
curl -X POST http://localhost:8795/api/platform/start \
  -H "x-internal-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user-123"}'

# Check status
curl http://localhost:8795/api/platform/status?userId=test-user-123 \
  -H "x-internal-api-key: $API_KEY"
```

## Controller Smoke Tests (Docker)

These scripts validate the machine-side Node controller introduced for KiloClaw.

Build the image first from `kiloclaw/`:

```bash
docker build --progress=plain -t kiloclaw:controller .
```

Then run one of:

- `bash scripts/controller-smoke-test.sh`
  - Fresh container (onboard path). Tests auth, env patch, version endpoints.
  - Use this when iterating on controller auth/proxy behavior.
- `bash scripts/controller-entrypoint-smoke-test.sh`
  - Volume-mounted container with pre-seeded config (doctor path).
  - Use this when changing bootstrap, env patching, or Docker wiring.
- `bash scripts/controller-proxy-auth-smoke-test.sh`
  - Validates proxy enforcement semantics end-to-end:
    no token -> `401`, correct proxy token -> pass-through.
  - Use this when changing proxy token logic or route/auth ordering.

All scripts support overrides via env vars (`IMAGE`, `PORT`, `TOKEN`).

## Admin Panel

### Access

Type `kilospeed` (or `ks`) on any Kilo page (not in a search box, just on the page itself)
to reveal the admin panel link. Or access it via the account icon (top-right)
→ dropdown → admin panel.

To return to the regular user view, remove `/admin` from the URL.

### Useful features for dev

- **Add credits:** Admin panel → add credits for your user to use paid models
  locally. Set an expiry date on dev credits.
- **KiloClaw instances:** Left nav → KiloClaw → shows all instances.
  - Click an instance to see live worker status, technical details.
  - The admin page shows the same data that Cloudflare's durable object stores
    for that Fly machine -- it's an accurate representation of known state.
  - "Derived Fly app" in technical details may point at production even in dev.
    Use the URL in **"live worker status"** instead (look for the `dev-` prefix).
  - Two alarm timestamps show when the next reconciliation will run.
  - After taking an action (start, destroy, etc.), the durable object takes a
    moment to process. The page may not update immediately.

## Architecture

```
Next.js (kilo.ai)                   KiloClaw Worker (claw.kilo.ai)
┌──────────────────┐                ┌────────────────────────────┐
│  /claw dashboard  │──[internal]──>│  /api/platform/* (DO RPC)  │
│  tRPC mutations   │   API key     │  provision/start/stop/...  │
└──────────────────┘                └─────────────┬──────────────┘
                                                  │
User browser ──[JWT cookie]──> catch-all proxy ───┤
                                    │             │
                                    ▼             ▼
                               Per-user      KiloClawInstance DO
                               Sandbox       (config, state, alarms)
                               Container
                                    │
                                    ▼
                               OpenClaw Gateway (:18789)
```

- **Platform routes** (`/api/platform/*`): Internal API key auth. Called by Next.js
  backend for lifecycle operations. Each route resolves the `KiloClawInstance` DO
  and calls an RPC method.
- **User routes** (`/api/kiloclaw/*`): JWT cookie auth. Returns user's config/status.
- **Catch-all proxy**: JWT cookie auth. Resolves the user's per-user sandbox and
  proxies HTTP/WebSocket to the OpenClaw gateway inside the container. Auto-recovers
  crashed instances on the next request.
- **Admin routes** (`/api/admin/*`): JWT cookie auth. Storage sync, gateway restart.
  Delegates to the DO via RPC.

## WebSocket Auth Flow

The OpenClaw gateway authenticates WebSocket connections via a token sent inside
the WebSocket protocol (NOT as a URL parameter). See
`~/fd-plans/kiloclaw/openclaw-auth-overview.md` for full details. The short version:

1. Next.js dashboard gets `gatewayToken` from the worker's platform status API
2. Dashboard renders the "Open" link as `https://claw.kilo.ai/#token={gatewayToken}`
3. OpenClaw SPA reads the fragment, saves token to localStorage
4. SPA sends token in the WebSocket `connect` frame's `params.auth.token`
5. Worker relays transparently -- does not inject or modify the token

## Fly Dashboard and Logs

### Viewing machine logs

From the admin panel's instance detail, click the Fly app link in the live
worker status section (the `dev-` prefixed one). In the Fly dashboard:
Machines (left nav) → click the console icon on your machine to see logs.

### Using `flyctl` locally

`flyctl` (the CLI, not an MCP server) is useful for debugging -- e.g., SSH
access to your deployed OpenClaw instance.

**Be careful letting AI agents use `flyctl`.** Fly auth does not distinguish
between dev and prod depending on key setup -- agents have been observed
targeting production machines. Use org-scoped tokens to limit the blast
radius.

## Observability

### Axiom

Cloudflare logs are ingested into Axiom. The Axiom MCP server can query logs
via your AI agent -- ask the agent to find the error line in the source code
first, then build an Axiom query for it. MCP query results occasionally
diverge from Axiom's actual output, so verify important queries in the
Axiom UI directly.

### Cloudflare Dashboard

Cloudflare's dashboard also has log searching.

## Reconciliation and Self-Healing

If provisioning fails and leaves a dangling volume, the reconciliation alarm
will clean it up automatically -- no need to delete it manually. The two alarm
timestamps on the admin instance detail page show when the next run is
scheduled.

Reconciliation runs on all instance statuses:

| Status                     | Alarm interval |
| -------------------------- | -------------- |
| Running                    | 5 min          |
| Destroying                 | 1 min          |
| Idle (provisioned/stopped) | 30 min         |

## Production Deployment

```bash
# Set required secrets
echo "$(openssl rand -hex 32)" | npx wrangler secret put NEXTAUTH_SECRET
echo "$(openssl rand -hex 32)" | npx wrangler secret put INTERNAL_API_SECRET
echo "$(openssl rand -hex 32)" | npx wrangler secret put GATEWAY_TOKEN_SECRET

# Set AI provider key (optional if users bring their own)
npx wrangler secret put KILOCODE_API_KEY

# Set R2 credentials
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CF_ACCOUNT_ID

# Set encryption key (get from the Next.js deployment's AGENT_ENV_VARS_PRIVATE_KEY)
npx wrangler secret put AGENT_ENV_VARS_PRIVATE_KEY

# WORKER_ENV defaults to "production" in wrangler.jsonc -- no secret needed.

# Deploy
pnpm deploy
```

**Secrets that must match the Next.js app:**

| Worker Secret                | Next.js Env Var                | Notes                                                 |
| ---------------------------- | ------------------------------ | ----------------------------------------------------- |
| `NEXTAUTH_SECRET`            | `NEXTAUTH_SECRET`              | Same HS256 signing key for JWT verification           |
| `INTERNAL_API_SECRET`        | `KILOCLAW_INTERNAL_API_SECRET` | Platform API authentication                           |
| `AGENT_ENV_VARS_PRIVATE_KEY` | `AGENT_ENV_VARS_PUBLIC_KEY`    | RSA key pair (worker has private, Next.js has public) |
| `WORKER_ENV`                 | `NODE_ENV`                     | Defaults to `production` in `wrangler.jsonc`          |

## Troubleshooting

**Fly machine can't reach your Next.js / "models require auth":**
Check that the tunnel is running and `KILOCODE_API_BASE_URL` in `.dev.vars`
matches the current tunnel URL. The dev-start script sets this automatically,
but if the tunnel restarts you'll need to re-run the script or update the URL
manually and restart the worker. Symptoms are either silent failure (three
dots, then nothing) or "models require authentication."

**"tag latest unknown manifest":**
The image tag in `FLY_IMAGE_TAG` doesn't exist in the Fly registry. Get
known-working values from a team member, or run `scripts/push-dev.sh` to
build and push your own.

**"out of capacity" / provision fails:**
Fly couldn't find a host. Retry `start` -- it usually works on the next
attempt. If it persists, check that `FLY_API_TOKEN` is valid and the dev org
has available regions.

**Docker push times out / "doesn't recognize the app":**
The `fly auth docker` token expires after 5 minutes. Push from a machine with
sufficient upload bandwidth, or use an org token instead.

**Container won't start:** Check `npx wrangler tail` for errors. Verify your
account has [Containers enabled](https://dash.cloudflare.com/?to=/:account/workers/containers).

**Gateway fails to start inside container:** Usually a missing AI provider key.
Check `npx wrangler tail` and Fly machine logs for startup errors.

**WebSocket connections fail:** `wrangler dev` has known issues with WebSocket
proxying through sandboxes. Deploy to Cloudflare for full WebSocket support.

**R2 not mounting:** R2 s3fs mounts only work in production, not with `wrangler dev`.
Verify all three R2 secrets are set.

**`validateRequiredEnv` blocking requests:** Only `NEXTAUTH_SECRET` and
`GATEWAY_TOKEN_SECRET` are checked. If either is missing, non-platform
routes return 500.

**Typecheck fails after changing wrangler.jsonc:** Run `pnpm types` to regenerate
`worker-configuration.d.ts`.

**Port 3000 already in use:**
Free port 3000 before starting. The Next.js app must run on 3000; other
services depend on it.
