# KiloClaw Development Guide

## Prerequisites

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5/month) -- required for Cloudflare Sandbox containers
- [Containers enabled](https://dash.cloudflare.com/?to=/:account/workers/containers) on your account
- Node.js 22+
- pnpm

## Quick Start

```bash
# Install dependencies (run from monorepo root)
pnpm install

# Copy the example env file
cp .dev.vars.example .dev.vars

# Edit .dev.vars -- at minimum set ANTHROPIC_API_KEY
# See "Environment Variables" below for details

# Run the dev server
pnpm start
```

`pnpm start` runs `wrangler dev`, which builds the worker and starts a local dev server.
The first request will pull the container image and cold-start it (1-2 minutes).

## Commands

```bash
pnpm start            # wrangler dev (local development)
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

Run `pnpm types` after changing `wrangler.jsonc` to regenerate the TypeScript
binding types.

## Environment Variables

All secrets are configured in `.dev.vars` for local development and via
`wrangler secret put` for production.

### Auth (required)

| Variable               | Description                                                                                                                    | How to generate        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `NEXTAUTH_SECRET`      | JWT signing key (HS256). Must match the Next.js app's secret.                                                                  | `openssl rand -hex 32` |
| `INTERNAL_API_SECRET`  | Shared key for platform API routes (`x-internal-api-key` header). Must match the Next.js app's `KILOCLAW_INTERNAL_API_SECRET`. | `openssl rand -hex 32` |
| `GATEWAY_TOKEN_SECRET` | HMAC key for per-sandbox gateway tokens. Worker-only (Next.js reads derived tokens from the API).                              | `openssl rand -hex 32` |

For local dev, any placeholder values work (the example file has defaults).
For production, generate real secrets and keep `NEXTAUTH_SECRET` and
`INTERNAL_API_SECRET` in sync with the Next.js deployment.

### AI Provider (at least one required)

Users can bring their own keys (BYOK), but the worker should have at least one
platform default so instances can start without user-provided keys.

| Variable            | Description              |
| ------------------- | ------------------------ |
| `ANTHROPIC_API_KEY` | Direct Anthropic API key |
| `OPENAI_API_KEY`    | Direct OpenAI API key    |

**Cloudflare AI Gateway** (alternative -- all three required together):

| Variable                        | Description                                         |
| ------------------------------- | --------------------------------------------------- |
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Your provider's API key, routed through the gateway |
| `CF_AI_GATEWAY_ACCOUNT_ID`      | Your Cloudflare account ID                          |
| `CF_AI_GATEWAY_GATEWAY_ID`      | Your AI Gateway ID                                  |
| `CF_AI_GATEWAY_MODEL`           | Optional model override: `provider/model-id`        |

Legacy AI Gateway (`AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL`) is still
supported but deprecated.

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

| Variable                     | Description                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AGENT_ENV_VARS_PRIVATE_KEY` | RSA private key (PEM). The matching public key lives in the Next.js backend as `AGENT_ENV_VARS_PUBLIC_KEY`. |

The Next.js app encrypts user secrets with the public key before sending them to
the worker. The worker decrypts them at container startup. Without this key,
user-provided encrypted secrets and channel tokens are silently skipped.

### Development Flags

| Variable              | Description                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| `DEV_MODE`            | Set to `true` to skip JWT auth and enable `allowInsecureAuth` in the container. **Local dev only.** |
| `DEBUG_ROUTES`        | Set to `true` to enable `/debug/*` endpoints.                                                       |
| `DEBUG_ROUTES_SECRET` | Auth key for debug routes (sent as `x-debug-api-key` header). Required when `DEBUG_ROUTES=true`.    |
| `WORKER_ENV`          | Set to `production` to enforce JWT `env` claim matching. When unset, env validation is skipped.     |

### Optional

| Variable             | Description                                        |
| -------------------- | -------------------------------------------------- |
| `ANTHROPIC_BASE_URL` | Custom Anthropic API base URL                      |
| `CDP_SECRET`         | Shared secret for CDP browser automation endpoints |
| `WORKER_URL`         | Public URL of the worker (required for CDP)        |

## Wrangler Bindings

These are configured in `wrangler.jsonc`, not as secrets:

| Binding             | Type           | Description                                                   |
| ------------------- | -------------- | ------------------------------------------------------------- |
| `Sandbox`           | Durable Object | `KiloClawSandbox` -- container lifecycle management           |
| `KILOCLAW_INSTANCE` | Durable Object | `KiloClawInstance` -- per-user instance state, config, alarms |
| `KILOCLAW_BUCKET`   | R2 Bucket      | `kiloclaw-data` -- persistent storage                         |
| `HYPERDRIVE`        | Hyperdrive     | Postgres connection for pepper validation + instance registry |

## Production Deployment

```bash
# Set required secrets
echo "$(openssl rand -hex 32)" | npx wrangler secret put NEXTAUTH_SECRET
echo "$(openssl rand -hex 32)" | npx wrangler secret put INTERNAL_API_SECRET
echo "$(openssl rand -hex 32)" | npx wrangler secret put GATEWAY_TOKEN_SECRET

# Set AI provider key
npx wrangler secret put ANTHROPIC_API_KEY

# Set R2 credentials
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler secret put CF_ACCOUNT_ID

# Set encryption key (get from the Next.js deployment's AGENT_ENV_VARS_PRIVATE_KEY)
npx wrangler secret put AGENT_ENV_VARS_PRIVATE_KEY

# Optional: enforce JWT env matching
echo "production" | npx wrangler secret put WORKER_ENV

# Deploy
pnpm deploy
```

**Secrets that must match the Next.js app:**

| Worker Secret                | Next.js Env Var                | Notes                                                 |
| ---------------------------- | ------------------------------ | ----------------------------------------------------- |
| `NEXTAUTH_SECRET`            | `NEXTAUTH_SECRET`              | Same HS256 signing key for JWT verification           |
| `INTERNAL_API_SECRET`        | `KILOCLAW_INTERNAL_API_SECRET` | Platform API authentication                           |
| `AGENT_ENV_VARS_PRIVATE_KEY` | `AGENT_ENV_VARS_PUBLIC_KEY`    | RSA key pair (worker has private, Next.js has public) |
| `WORKER_ENV`                 | `NODE_ENV`                     | Should both be `production` in prod                   |

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
- **Debug routes** (`/debug/*`): Requires `DEBUG_ROUTES=true` + API key header.
  Accepts `?sandboxId=` param to target a specific sandbox.

## WebSocket Auth Flow

The OpenClaw gateway authenticates WebSocket connections via a token sent inside
the WebSocket protocol (NOT as a URL parameter). See
`~/fd-plans/kiloclaw/openclaw-auth-overview.md` for full details. The short version:

1. Next.js dashboard gets `gatewayToken` from the worker's platform status API
2. Dashboard renders the "Open" link as `https://claw.kilo.ai/#token={gatewayToken}`
3. OpenClaw SPA reads the fragment, saves token to localStorage
4. SPA sends token in the WebSocket `connect` frame's `params.auth.token`
5. Worker relays transparently -- does not inject or modify the token

## Local Dev Without Auth

Set `DEV_MODE=true` in `.dev.vars`. This skips JWT validation and sets
`OPENCLAW_DEV_MODE=true` in the container (bypasses device pairing).

In dev mode the catch-all proxy returns 401 because no `userId` is derived
(no JWT = no identity = no per-user sandbox). To test the full flow locally,
use the platform API routes to provision and start an instance:

```bash
# Provision an instance (replace with a test user ID)
curl -X POST http://localhost:8787/api/platform/provision \
  -H "x-internal-api-key: dev-internal-secret" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user-123"}'

# Start it
curl -X POST http://localhost:8787/api/platform/start \
  -H "x-internal-api-key: dev-internal-secret" \
  -H "Content-Type: application/json" \
  -d '{"userId": "test-user-123"}'

# Check status
curl http://localhost:8787/api/platform/status?userId=test-user-123 \
  -H "x-internal-api-key: dev-internal-secret"
```

## Troubleshooting

**Container won't start:** Check `npx wrangler tail` for errors. Verify your
account has [Containers enabled](https://dash.cloudflare.com/?to=/:account/workers/containers).

**Gateway fails to start inside container:** Usually a missing AI provider key.
Check debug logs at `/debug/logs?sandboxId=<id>` (requires `DEBUG_ROUTES=true`).

**WebSocket connections fail:** `wrangler dev` has known issues with WebSocket
proxying through sandboxes. Deploy to Cloudflare for full WebSocket support.

**R2 not mounting:** R2 s3fs mounts only work in production, not with `wrangler dev`.
Verify all three R2 secrets are set.

**`validateRequiredEnv` blocking requests:** Only `NEXTAUTH_SECRET` and
`GATEWAY_TOKEN_SECRET` are checked. If either is missing, non-debug/non-platform
routes return 500.

**Typecheck fails after changing wrangler.jsonc:** Run `pnpm types` to regenerate
`worker-configuration.d.ts`.
