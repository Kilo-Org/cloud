# AGENTS.md

## What This Is

KiloClaw is a Cloudflare Worker that runs per-user OpenClaw AI assistant instances on Fly.io Machines. The CF Worker handles auth, config management, and proxies HTTP/WebSocket traffic to each user's Fly Machine via Fly Proxy.

## Hard Invariants

These are non-negotiable. Do not reintroduce shared/fallback paths.

- **No shared mode.** Every request, DO, and machine is user-scoped. There is no global machine, no shared fallback, no optional userId parameters.
- **User scoping.** DOs are currently keyed by `idFromName(userId)` (one instance per user). Machine names use `sandboxIdFromUserId(userId)`. Both are deterministic and reversible. **Known limitation**: when multi-sandbox-per-user is needed, the DO key should change to `sandboxId` or an instance ID, and the platform API will need to accept a sandbox/instance identifier alongside userId.
- **`buildEnvVars` requires `sandboxId` and `gatewayTokenSecret`.** Gateway token and `AUTO_APPROVE_DEVICES` are always set. No fallback to worker-level channel tokens.
- **Next.js is the sole Postgres writer.** The worker only reads via Hyperdrive (pepper validation + DO restore). The DB stores registry data (`user_id`, `sandbox_id`, `created_at`, `destroyed_at`) plus config backup. Operational state (status, timestamps, Fly machine/volume IDs) lives in the DO only.
- **DO restore from Postgres.** If DO SQLite is wiped, `start(userId)` reads the active instance row from Postgres and repopulates the DO state. This is the backup path for development mistakes that corrupt DO storage.
- **Two-phase destroy.** Fly resource IDs (`pendingDestroyMachineId`, `pendingDestroyVolumeId`) are persisted before deletion attempts. DO state is only cleared when both are confirmed deleted. The alarm retries on failure.
- **No machine recreation on transient errors.** `startExistingMachine()` only creates a new machine on 404 (confirmed gone). Transient Fly API errors (500, timeout) are re-thrown, not masked by duplicate creation.
- **Machine ID persisted before waiting.** `createNewMachine()` writes `flyMachineId` to durable storage immediately after `fly.createMachine()`, before `waitForState()`. This prevents orphaning machines if the wait times out.

## Architecture

```
Browser -> CF Worker (claw.kilo.ai)
             | JWT auth, derive userId -> look up flyMachineId from DO
             | add fly-force-instance-id header
             v
          Fly Proxy ({FLY_APP_NAME}.fly.dev, TLS)
             | routes to pinned machine
             v
          Fly Machine (openclaw gateway on port 18789)
             | Fly Volume mounted at /root (persistent storage)
```

### Fly Proxy Routing

The worker forwards all requests to `https://{FLY_APP_NAME}.fly.dev` with the
`fly-force-instance-id: {machineId}` header, which pins the request to a specific
Fly Machine. Fly Proxy handles TLS and strips the header before forwarding to the
machine. WebSocket upgrade requests use the same header for connection pinning.

### Persistence

Each user gets a dedicated Fly Volume (NVMe-backed block storage) mounted at `/root`.
This means `/root/.openclaw` (config) and `/root/clawd` (workspace) persist across
machine restarts without any sync mechanism. Volumes are region-pinned -- a volume
created in `iad` means the machine always starts in `iad`.

## Architecture Map

```
src/
├── index.ts                          # Hono app, middleware chain, catch-all proxy via Fly Proxy
├── routes/
│   ├── api.ts                        # /api/admin/* (DO RPC wrappers, 410 stubs for removed sync)
│   ├── kiloclaw.ts                   # /api/kiloclaw/* (user-facing, JWT auth)
│   ├── platform.ts                   # /api/platform/* (internal API key auth)
│   ├── debug.ts                      # /debug/* (operator tools, ?machineId= param)
│   ├── access-gateway.ts             # Access code redemption, cookie setting, redirects
│   └── public.ts                     # /health (no auth)
├── auth/
│   ├── middleware.ts                  # JWT auth + pepper validation via Hyperdrive
│   ├── jwt.ts                        # Token parsing/verification
│   ├── gateway-token.ts              # HMAC-SHA256 derivation for per-sandbox tokens
│   ├── sandbox-id.ts                 # userId <-> sandboxId (base64url, reversible)
│   └── debug-gate.ts                 # Debug route access control
├── durable-objects/
│   └── kiloclaw-instance.ts          # DO: lifecycle state machine, reconciliation, two-phase destroy
├── fly/
│   ├── client.ts                     # Fly Machines + Volumes API HTTP client
│   └── types.ts                      # Fly API type definitions (incl. FlyWaitableState)
├── gateway/
│   └── env.ts                        # buildEnvVars: 5-layer env var pipeline
├── utils/
│   ├── encryption.ts                 # RSA+AES envelope decryption (secrets, channels)
│   └── logging.ts                    # URL param redaction
├── schemas/
│   └── instance-config.ts            # Zod schemas for DO persisted state
├── db/
│   └── stores/InstanceStore.ts       # Postgres registry (insert, markDestroyed, find)
├── config.ts                         # Constants (ports, timeouts, alarm cadence, default machine spec)
└── types.ts                          # KiloClawEnv, AppEnv
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Routing**: Hono
- **Compute**: Fly.io Machines (Firecracker micro-VMs via REST API)
- **Persistent Storage**: Fly Volumes (NVMe, mounted at `/root`)
- **Durable Objects**: RPC-style (not fetch-based) -- use typed stubs, not `fetch()`
- **Database**: Hyperdrive (Postgres) for pepper validation and instance registry
- **Auth**: `jose` for JWT verification

## Instance Statuses

| Status        | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `provisioned` | Config stored, volume created, no machine yet            |
| `running`     | Machine is started and healthy                           |
| `stopped`     | Machine is stopped, volume persists                      |
| `destroying`  | Two-phase destroy in progress, pending resource deletion |

The alarm runs for ALL statuses (not just `running`). `destroying` short-circuits reconciliation -- only retries pending deletes, never recreates resources.

## Environment Variables

### Required (set via `wrangler secret put`)

| Variable               | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `FLY_API_TOKEN`        | Bearer token for Fly Machines API                             |
| `FLY_APP_NAME`         | Fly App hosting all user machines (e.g., `kiloclaw-machines`) |
| `NEXTAUTH_SECRET`      | JWT verification secret (shared with Next.js)                 |
| `INTERNAL_API_SECRET`  | Platform API auth key                                         |
| `GATEWAY_TOKEN_SECRET` | HMAC secret for per-user gateway tokens                       |

### Optional

| Variable                               | Purpose                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `FLY_REGION`                           | Default region for new volumes/machines. Comma-separated priority list: `us,eu` tries US first, falls back to EU. (default: `us,eu`) |
| `KILOCODE_API_BASE_URL`                | Override KiloCode API URL                                                                                                            |
| `AGENT_ENV_VARS_PRIVATE_KEY`           | RSA private key for decrypting user secrets                                                                                          |
| `TELEGRAM_DM_POLICY`                   | Telegram DM policy (passed through to machine)                                                                                       |
| `DISCORD_DM_POLICY`                    | Discord DM policy (passed through to machine)                                                                                        |
| `DEV_MODE`                             | Enable dev mode features                                                                                                             |
| `DEBUG_ROUTES` / `DEBUG_ROUTES_SECRET` | Enable debug endpoints                                                                                                               |

### Fly.io Regions

Volumes are region-pinned. Once a user's volume is created in a region, their machine always starts there. `FLY_REGION` accepts a comma-separated priority list (e.g., `us,eu`) -- Fly tries the first region/alias, falls back to the next if unavailable. Geographic aliases (`us`, `eu`, `sa`) expand to all regions in that area. See [Fly regions docs](https://fly.io/docs/reference/regions/) for the full list.

## Commands

```bash
pnpm typecheck        # tsgo
pnpm lint             # eslint v9 + typescript-eslint
pnpm format           # prettier
pnpm test             # vitest (node)
pnpm types            # regenerate worker-configuration.d.ts (run after changing wrangler.jsonc)
pnpm start            # wrangler dev
```

## Change Checklist

Before submitting any change:

1. Run `pnpm typecheck && pnpm test && pnpm lint`
2. Update tests in the same PR -- do not defer
3. Do not reintroduce optional `userId` or `sandboxId` parameters (they are always required)
4. If changing `start-openclaw.sh`, bump the cache bust in the Dockerfile

## Test Targets by Change Type

| What you changed                      | Test files to update                                  |
| ------------------------------------- | ----------------------------------------------------- |
| Auth middleware, JWT, pepper          | `src/auth/middleware.test.ts`, `src/auth/jwt.test.ts` |
| Gateway env var building              | `src/gateway/env.test.ts`                             |
| Fly API client                        | `src/fly/client.test.ts`                              |
| DO lifecycle, reconciliation, destroy | `src/durable-objects/kiloclaw-instance.test.ts`       |
| Encryption / decryption               | `src/utils/encryption.test.ts`                        |
| Debug route gating                    | `src/auth/debug-gate.test.ts`                         |
| Sandbox ID derivation                 | `src/auth/sandbox-id.test.ts`                         |
| Gateway token derivation              | `src/auth/gateway-token.test.ts`                      |

## Code Style

- See `/.kilocode/rules/coding-style.md` for project-wide rules
- Prefer `type` over `interface`
- Avoid `as` and `!` -- use `satisfies` or flow-sensitive typing
- No mocks where avoidable -- assert on results

## Gateway Configuration

OpenClaw configuration is built at machine startup by `start-openclaw.sh`:

1. If no config exists (first boot), `openclaw onboard --non-interactive` creates one
2. The startup script patches the config for channels, gateway auth, and KiloCode provider
3. Gateway starts with `openclaw gateway --allow-unconfigured --bind lan`

Config and workspace persist across machine restarts via the Fly Volume at `/root`.

### Env Var Transport

All user config is transported to the machine via environment variables set in the Fly machine config. The startup script reads these env vars and patches the openclaw config file.

| Env var                  | Source                            | Purpose                     |
| ------------------------ | --------------------------------- | --------------------------- |
| `KILOCODE_API_KEY`       | User config (DO)                  | KiloCode API authentication |
| `KILOCODE_DEFAULT_MODEL` | User config (DO)                  | Default model for agents    |
| `KILOCODE_MODELS_JSON`   | User config (DO), JSON-serialized | Available model list        |
| `KILOCODE_API_BASE_URL`  | Worker env                        | API base URL override       |
| `OPENCLAW_GATEWAY_TOKEN` | Derived from sandboxId            | Per-user gateway auth       |
| `AUTO_APPROVE_DEVICES`   | Hardcoded `true`                  | Skip device pairing         |
| `OPENCLAW_DEV_MODE`      | Worker env (`DEV_MODE`)           | Dev mode features           |
| `TELEGRAM_BOT_TOKEN`     | Decrypted channel token           | Telegram channel            |
| `DISCORD_BOT_TOKEN`      | Decrypted channel token           | Discord channel             |
| `SLACK_BOT_TOKEN`        | Decrypted channel token           | Slack channel               |
| `SLACK_APP_TOKEN`        | Decrypted channel token           | Slack channel               |
| `TELEGRAM_DM_POLICY`     | Worker env                        | Telegram DM policy          |
| `DISCORD_DM_POLICY`      | Worker env                        | Discord DM policy           |

### AI Provider Selection

KiloClaw is KiloCode-only:

1. `KILOCODE_API_KEY` is required at startup.
2. `start-openclaw.sh` patches `config.models.providers.kilocode`.
3. `agents.defaults.model.primary` is set from `KILOCODE_DEFAULT_MODEL` (or fallback default).
4. Model list is read from `KILOCODE_MODELS_JSON` env var (preferred), falling back to file at `/root/.openclaw/kilocode-models.json`, then baked-in defaults.

## OpenClaw Config Schema

OpenClaw has strict config validation. Common gotchas:

- `agents.defaults.model` must be `{ "primary": "provider/model-id" }` not a string
- `gateway.mode` must be `"local"` for headless operation
- No `webchat` channel -- the Control UI is served automatically by the gateway
- `gateway.bind` is not a config option -- use `--bind` CLI flag

## Docker Image

The Dockerfile is based on `debian:bookworm-slim` and installs Node.js 22 + OpenClaw.
The image is pushed to Fly's registry (`registry.fly.io/{FLY_APP_NAME}`) via CI.

The Dockerfile includes a cache bust comment. When changing `start-openclaw.sh`, bump the version:

```dockerfile
# Build cache bust: 2026-02-13-v40-models-env-var
```

## Fly Machine Lifecycle

| Operation          | What happens                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Provision**      | Creates a Fly Volume in the configured region. Stores config in DO. Schedules reconciliation alarm.                                                                                                                |
| **Start**          | Ensures volume exists. Creates a Fly Machine (or starts an existing stopped one) with volume mounted at `/root`, metadata tags, and env vars. Persists machine ID immediately. Schedules health check alarm.       |
| **Stop**           | Stops the Fly Machine via API. Volume persists. Alarm continues at idle cadence.                                                                                                                                   |
| **Restart**        | Stops machine, updates config (env vars, image, metadata), starts it. Volume persists.                                                                                                                             |
| **Destroy**        | Two-phase: persists pending IDs + `status='destroying'`, attempts Fly deletions, only clears DO state when both confirmed. Alarm retries failures.                                                                 |
| **Reconciliation** | Alarm runs for all statuses. Running: 5 min. Destroying: 1 min. Idle (provisioned/stopped): 30 min. Fixes status drift, missing volumes, stale machine IDs, wrong mounts, and recovers lost IDs from Fly metadata. |

## Metadata Recovery

Each Fly Machine is tagged with `kiloclaw_user_id` and `kiloclaw_sandbox_id` metadata. When the DO has no `flyMachineId` (e.g., after a DO wipe + Postgres restore), the reconciliation alarm queries Fly's list machines endpoint filtered by `metadata.kiloclaw_user_id`. Selection is deterministic: prefer `started` > `starting` > `stopped` > `created`, tie-break by newest `updated_at`. Volume ID is recovered from the machine's mount config. A cooldown prevents hammering the Fly API when there's genuinely nothing to recover.

## Security Model

- CF Worker handles all auth (JWT, API keys, gateway tokens)
- Fly Proxy is not authenticated -- anyone can reach `{app}.fly.dev`
- Protection layers: machine IDs are opaque + openclaw gateway validates per-user HMAC gateway token
- Future: sidecar proxy on each machine for defense-in-depth

## Default Machine Spec

`shared-cpu-2x`, 4GB RAM (~$21.54/mo when running, free when stopped). Configurable per-user via `machineSize` in the provision API.
