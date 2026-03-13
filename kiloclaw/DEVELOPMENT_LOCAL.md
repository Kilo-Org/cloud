# KiloClaw Local Development Guide (Fly.io)

## Prerequisites

- Node.js 22+
- pnpm
- [Fly CLI](https://fly.io/docs/flyctl/install/) (`fly`)
- Docker (for building/pushing images)
- Access to the **Kilo (dev)** Fly org (accept the invite from your email)
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or [ngrok](https://ngrok.com/) (so remote Fly machines can call back to your local Next.js)

Install `cloudflared` (separate from Wrangler) via Homebrew:

```bash
brew install cloudflared
```

## How it fits together

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
3. Create an org-scoped token for dev use (personal tokens also have production
   access):

```bash
fly tokens create -o kilo-dev my-dev-token
```

Save this token -- you'll need it for `FLY_API_TOKEN` in `.dev.vars`.

## Quick Start

```bash
# 1. Install dependencies (run from monorepo root)
pnpm install

# 2. Copy the example env file (from kiloclaw/)
cp kiloclaw/.dev.vars.example kiloclaw/.dev.vars

# 3. Edit .dev.vars -- see "Environment Variables" below

# 4. Ensure Next.js has KiloClaw env vars (from monorepo root).
#    `vercel env pull` includes KILOCLAW_API_URL and
#    KILOCLAW_INTERNAL_API_SECRET. If you haven't run it yet, see
#    the root DEVELOPMENT.md for Next.js setup.

# 5. Start the local database (from monorepo root)
docker compose -f dev/docker-compose.yml up -d

# 6. Run database migrations (from monorepo root)
pnpm drizzle migrate

# 7. Start the tunnel (separate terminal)
cloudflared tunnel --url http://localhost:3000
# Copy the tunnel URL into KILOCODE_API_BASE_URL in .dev.vars

# 8. Start Next.js (separate terminal, from monorepo root)
pnpm dev

# 9. Start the KiloClaw worker (separate terminal, from kiloclaw/)
pnpm run dev
```

Each of the three long-running processes (tunnel, Next.js, worker) needs its
own terminal tab. The Next.js app must run on port 3000 -- other services
depend on it.

## Tunnel setup

Use Cloudflare Tunnel (recommended) or ngrok to expose your local Next.js:

```bash
# Cloudflare Tunnel (free, no account needed for quick tunnels)
cloudflared tunnel --url http://localhost:3000

# Or ngrok
ngrok http 3000
```

Copy the tunnel URL and set it in `.dev.vars`:

```
KILOCODE_API_BASE_URL=https://<your-tunnel>.trycloudflare.com/api/gateway/
```

### Free vs named tunnels

- **Free quick tunnel**: hostname changes on every restart of `cloudflared`.
  Update `.dev.vars` and restart the worker when the URL changes.
- **Named tunnel**: preconfigure in the Cloudflare dashboard for a persistent
  hostname (e.g., `yourname.devclaw.dev`). Avoids updating the URL on each
  restart.

### If the tunnel isn't working

The error manifests in OpenClaw as one of:

1. Three dots (`...`) appear, then **nothing happens** (silent failure), OR
2. OpenClaw says **"models require authentication"**

If you see either, check:

- `cloudflared` (or ngrok) is running
- `KILOCODE_API_BASE_URL` in `.dev.vars` matches the current tunnel URL
- The KiloClaw worker was restarted after changing `.dev.vars`

## Environment Variables

There are two env files to configure:

### 1. `kiloclaw/.dev.vars` (worker secrets)

Copy `.dev.vars.example` and fill in:

**Auth** -- must match the Next.js app's values:

| Variable               | Description                                                                 |
| ---------------------- | --------------------------------------------------------------------------- |
| `NEXTAUTH_SECRET`      | JWT signing key. Must match the Next.js app's `NEXTAUTH_SECRET`             |
| `INTERNAL_API_SECRET`  | Platform API key. Must match Next.js `KILOCLAW_INTERNAL_API_SECRET`         |
| `GATEWAY_TOKEN_SECRET` | HMAC key for per-sandbox gateway tokens. Can be any arbitrary value in dev. |
| `WORKER_ENV`           | Set to `development`                                                        |

`NEXTAUTH_SECRET` and `INTERNAL_API_SECRET` must match the Next.js app's
values. Pull them from Vercel (`vercel env pull` from the monorepo root) or
get them from a team member.

**Fly.io** -- requires access to the Kilo (dev) org:

| Variable           | Description                                                                             |
| ------------------ | --------------------------------------------------------------------------------------- |
| `FLY_API_TOKEN`    | Fly org token. Generate with `fly tokens create -o kilo-dev my-dev-token`               |
| `FLY_ORG_SLUG`     | Fly org slug (run `fly orgs list` to find it)                                           |
| `FLY_REGISTRY_APP` | Shared Fly app that holds Docker images (e.g., `kiloclaw-dev`)                          |
| `FLY_APP_NAME`     | Legacy fallback app name for existing instances (may be removed in future)              |
| `FLY_REGION`       | Region priority list, e.g. `us,eu`. Tries US first, falls back to EU, then gives up.    |
| `FLY_IMAGE_TAG`    | Docker image tag. Set automatically by `scripts/push-dev.sh`, or use `latest` to start. |
| `FLY_IMAGE_DIGEST` | Docker image digest. Set automatically by `scripts/push-dev.sh`.                        |
| `OPENCLAW_VERSION` | OpenClaw version in the image. Set automatically by `scripts/push-dev.sh`.              |

`FLY_IMAGE_TAG`, `FLY_IMAGE_DIGEST`, and `OPENCLAW_VERSION` together control
what version gets deployed by default for your dev instances. The build script
auto-updates all three. For initial setup, ask a team member for known-working
values or use `latest` (if a `latest` tag exists in the registry).

**Tunnel / API** -- so Fly machines can reach your local Next.js:

| Variable                | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `KILOCODE_API_BASE_URL` | Your tunnel URL + `/api/gateway/` (see tunnel setup above) |

**Encryption** -- for decrypting user-provided secrets:

| Variable                     | Description                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `AGENT_ENV_VARS_PRIVATE_KEY` | RSA private key (PEM). Get the **dev** version from 1Password (engineering vault). Quote the value in `.dev.vars`. |

**Other:**

| Variable                   | Description                                       |
| -------------------------- | ------------------------------------------------- |
| `OPENCLAW_ALLOWED_ORIGINS` | Comma-separated origins for WebSocket connections |

### 2. `.env.local` (Next.js, monorepo root)

The Next.js app also needs these two variables to talk to the KiloClaw worker.
Both are included in `vercel env pull` (see root `DEVELOPMENT.md`):

| Variable                       | Description                                     |
| ------------------------------ | ----------------------------------------------- |
| `KILOCLAW_API_URL`             | Worker URL, e.g. `http://localhost:8795`        |
| `KILOCLAW_INTERNAL_API_SECRET` | Must match `INTERNAL_API_SECRET` in `.dev.vars` |

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

## Commands

```bash
pnpm run dev          # wrangler dev (local development)
pnpm typecheck        # tsgo --noEmit
pnpm lint             # eslint
pnpm lint:fix         # eslint --fix
pnpm format           # prettier --write
pnpm format:check     # prettier --check
pnpm test             # vitest run
pnpm test:watch       # vitest (watch mode)
pnpm test:coverage    # vitest --coverage
pnpm types            # regenerate worker-configuration.d.ts
pnpm deploy           # wrangler deploy
```

Run `pnpm types` after changing `wrangler.jsonc` to regenerate TypeScript
binding types.

## Controller Smoke Tests (Docker)

These scripts validate the machine-side Node controller. Build the image
first from `kiloclaw/`:

```bash
docker build --progress=plain -t kiloclaw:controller .
```

Then run one of:

- `bash scripts/controller-smoke-test.sh` -- direct controller startup.
  Use for quick auth/proxy sanity checks.
- `bash scripts/controller-entrypoint-smoke-test.sh` -- full startup path
  via `start-openclaw.sh`. Use when changing startup script or Docker wiring.
- `bash scripts/controller-proxy-auth-smoke-test.sh` -- proxy enforcement
  semantics (401 without token, pass-through with token). Use when changing
  proxy token logic.

All scripts support overrides via env vars (`IMAGE`, `PORT`, `TOKEN`).

## Troubleshooting

**Fly machine can't reach your Next.js / "models require auth":**
Check that the tunnel is running and `KILOCODE_API_BASE_URL` in `.dev.vars`
matches the current tunnel URL. Restart the worker after changing it. Symptoms
are either silent failure (three dots, then nothing) or "models require
authentication."

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

**Typecheck fails after changing wrangler.jsonc:**
Run `pnpm types` to regenerate `worker-configuration.d.ts`.

**Port 3000 already in use:**
Free port 3000 before starting. The Next.js app must run on 3000; other
services depend on it.
