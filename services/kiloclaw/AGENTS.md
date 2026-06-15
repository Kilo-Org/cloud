# AGENTS.md

## What This Is

KiloClaw is a Cloudflare Worker that runs per-user OpenClaw AI assistant instances on Fly.io Machines. The CF Worker handles auth, config management, and proxies HTTP/WebSocket traffic to each user's Fly Machine via Fly Proxy.

## Hard Invariants

These are non-negotiable. Do not reintroduce shared/fallback paths.

- **No shared mode.** Every request, DO, and machine is user-scoped. There is no global machine, no shared fallback, no optional userId parameters.
- **User scoping (transitioning to multi-instance).** Legacy: Instance DOs are keyed by `idFromName(userId)` (one instance per user), sandboxId = `sandboxIdFromUserId(userId)`. **Multi-instance (in progress):** Instance DOs will be keyed by `idFromName(instanceId)` where `instanceId` = `kiloclaw_instances.id` UUID. sandboxId = `sandboxIdFromInstanceId(instanceId)` → `ki_{uuid-no-dashes}` (35 chars). The `ki_` prefix distinguishes instance-keyed sandboxIds from legacy userId-derived ones (base64url). All routes accept an optional `?instanceId=` query param; when absent, they fall back to the legacy userId-keyed path. See the "Multi-Instance Migration" section below for details.
- **Per-user Fly Apps (unchanged by multi-instance).** Each user gets a dedicated Fly App (`acct-{hash}` in production, `dev-{hash}` in development), managed by the `KiloClawApp` DO. Multiple instances per user share one Fly app. The App DO stays user-keyed.
- **Per-user Fly Apps (legacy detail).** New instances get a per-user Fly app created by `KiloClawApp.ensureApp()`. The app name (`flyAppName`) is cached in the Instance DO for proxy routing. Legacy instances without `flyAppName` fall back to `FLY_APP_NAME`. Apps are kept alive after instance destroy (empty apps cost nothing) and reused on re-provision.
- **`buildEnvVars` requires `sandboxId` and `gatewayTokenSecret`.** Returns `{ env, sensitive }` split. Sensitive values are AES-256-GCM encrypted and prefixed with `KILOCLAW_ENC_` before placement in machine config.env. Gateway token and `AUTO_APPROVE_DEVICES` are always set. No fallback to worker-level channel tokens.
- **Env var name constraints.** User-provided `envVars` and `encryptedSecrets` keys must be valid shell identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`) and must not use reserved prefixes `KILOCLAW_ENC_` or `KILOCLAW_ENV_`. Validated at schema level (ingest) and runtime (decrypt block).
- **Token comparisons must be timing-safe.** Never compare auth/proxy tokens with `===`/`!==`. Use `timingSafeTokenEqual` from `controller/src/auth.ts` (or an equivalent `crypto.timingSafeEqual`-based helper) for bearer/proxy token validation.
- **`kiloclaw_instances` write split.** The Worker is the sole inserter of rows (`insertProvisionedInstanceRecord`, enforced by `.specs/kiloclaw-datamodel.md` rule 21) — infrastructure is provisioned first, the row reflects it. The Worker also owns updates to a small set of DO-mirrored columns: destroy finalization (`markDestroyedInPostgresHelper`) and denormalized operational metadata (`tracked_image_tag`, `instance_type`, `admin_size_override`) written via `syncTrackedImageTagToPostgresHelper` / `syncInstanceTypeToPostgresHelper` / `syncAdminSizeOverrideToPostgresHelper`. The DO is the source of truth for these columns; the Postgres copy is a denormalized read cache for SQL-filterable admin tooling. `tracked_image_tag` and `instance_type` are written by the alarm reconciler when DO state changes; `admin_size_override` is written only on explicit admin RPC paths (set/clear/auto-clear-on-tier-resize) — there is no observation path. Next.js owns updates to ownership, lifecycle, and billing columns (`organization_id`, `name`, `inbound_email_enabled`, soft-delete via `markActiveInstanceDestroyed`, etc. in `apps/web/src/lib/kiloclaw/instance-registry.ts` and `instance-lifecycle.ts`). Next.js never inserts `kiloclaw_instances` rows. New Worker writes beyond the DO-mirrored carve-out require explicit justification — prefer a Next.js tRPC procedure unless the data fundamentally lives in the DO and is being denormalized for query-shape reasons.
- **Fresh-provision admission reservations.** Fresh instance creation MUST acquire durable, non-routable context admission in `KiloClawRegistry` before invoking `KiloClawInstance.provision()` or provider allocation. A reservation is not a Postgres instance record and grants no access. Personal admission is per user; organization admission is per assigned user within `org:{orgId}`. Pending or reconciliation-required attempts fail closed and MUST NOT be exposed through routable registry entry reads. Registry admission and finalization are correctness-critical; do not treat reservation publication failure as best-effort routing metadata.

### Fresh Provision Admission State

```
fresh create request
  |
  | beginFreshProvision (atomic unresolved-scope insert)
  v
in_progress
  |\
  | \ provider/row/bootstrap succeeds
  |  v
  |  completed + routable Registry entry
  |       |
  |       | finalized destroy
  |       v
  |    released + tombstone
  |
  \ ambiguous provider/row/bootstrap failure
     v
  failed_requires_reconciliation
       |
       | confirmed cleanup / destroy finalization
       v
    released + tombstone or no route
```

- `beginFreshProvision()` is the only entry to `in_progress`; the partial unique unresolved-scope index prevents a second fresh executor for the same owner/user context.
- `completeFreshProvision()` publishes the routable entry only after canonical instance insertion and subscription bootstrap succeed. `repairCompletedProvision()` is the idempotent recovery path when that completion acknowledgement is lost.
- `failFreshProvision()` is used only when provider side effects may exist and cleanup is not yet confirmed. `releaseFreshProvision()` is used only after confirmed cleanup or active-instance reconciliation proves the candidate is safe to abandon.
- `finalizeDestroyedInstance()` atomically tombstones the routable entry and transitions any unresolved/completed reservation to terminal `released`, so delayed repair cannot revive a destroyed route.
- `publishRecoveredInstance()` is limited to explicit subscription-recovery flows after bootstrap succeeds and refuses to publish if a destroy tombstone already exists.
- `createInstance()` remains legacy/lazy routing publication and must not be used to complete a fresh reservation.

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

Each user gets a dedicated Fly App (`acct-{hash}` in production, `dev-{hash}` in development). The worker forwards
requests to `https://{flyAppName}.fly.dev` with the `fly-force-instance-id: {machineId}`
header, which pins the request to a specific Fly Machine. Fly Proxy handles TLS and
strips the header before forwarding to the machine. WebSocket upgrade requests use
the same header for connection pinning. Legacy instances without a per-user app fall
back to `FLY_APP_NAME`.

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
│   ├── access-gateway.ts             # Access code redemption, cookie setting, redirects
│   └── public.ts                     # /health (no auth)
├── auth/
│   ├── middleware.ts                  # JWT auth + pepper validation via Hyperdrive
│   ├── jwt.ts                        # Token parsing/verification
│   ├── gateway-token.ts              # HMAC-SHA256 derivation for per-sandbox tokens
│   └── sandbox-id.ts                 # userId <-> sandboxId (base64url) + instanceId validation/derivation
├── durable-objects/
│   ├── kiloclaw-app.ts               # DO: per-user Fly App lifecycle (create app, allocate IPs, env key)
│   └── kiloclaw-instance.ts          # DO: lifecycle state machine, reconciliation, two-phase destroy
├── fly/
│   ├── apps.ts                       # Fly Apps + IP allocation REST API (per-user apps)
│   ├── client.ts                     # Fly Machines + Volumes API HTTP client
│   ├── secrets.ts                    # Fly App Secrets REST API client (env encryption key)
│   └── types.ts                      # Fly API type definitions (incl. FlyWaitableState)
├── gateway/
│   └── env.ts                        # buildEnvVars: 5-layer env var pipeline (env/sensitive split)
├── utils/
│   ├── encryption.ts                 # RSA+AES envelope decryption (secrets, channels)
│   ├── env-encryption.ts             # AES-256-GCM encryption for machine env var values
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

| Status | Meaning |
|---|---|
| `provisioned` | Config stored, volume created, no machine yet |
| `starting` | startAsync() fired; start() running in background via waitUntil |
| `running` | Machine is started and healthy |
| `stopped` | Machine is stopped, volume persists |
| `restoring` | Snapshot restore in progress via CF Queue; all lifecycle ops blocked |
| `destroying` | Two-phase destroy in progress, pending resource deletion |

The alarm runs for ALL statuses (not just `running`). `destroying` short-circuits reconciliation -- only retries pending deletes, never recreates resources. `starting` uses a 1-min alarm cadence; reconcileStarting() checks Fly machine state and transitions to `running` or `stopped`. If `startingAt` is set and more than 5 minutes have elapsed, it falls back to `stopped` automatically. `restoring` skips reconciliation entirely (the CF Queue worker owns the lifecycle); the alarm detects stuck restores (>30 min) and resets to `stopped`.

## Environment Variables

### Required (set via `wrangler secret put`)

| Variable | Purpose |
|---|---|
| `FLY_API_TOKEN` | Bearer token for Fly Machines API (org-scoped) |
| `FLY_ORG_SLUG` | Fly org for creating per-user apps (e.g., `kilo-679`) |
| `FLY_REGISTRY_APP` | Shared app for Docker image registry (e.g., `kiloclaw-machines`) |
| `FLY_APP_NAME` | Legacy fallback for existing instances without per-user apps |
| `NEXTAUTH_SECRET` | JWT verification secret (shared with Next.js) |
| `INTERNAL_API_SECRET` | Platform API auth key |
| `GATEWAY_TOKEN_SECRET` | HMAC secret for per-user gateway tokens |

### Optional

| Variable | Purpose |
|---|---|
| `FLY_REGION` | Default region for new volumes/machines. Comma-separated priority list: `us,eu` tries US first, falls back to EU. (default: `us,eu`) |
| `KILOCODE_API_BASE_URL` | Override KiloCode API URL |
| `AGENT_ENV_VARS_PRIVATE_KEY` | RSA private key for decrypting user secrets |
| `TELEGRAM_DM_POLICY` | Telegram DM policy (passed through to machine) |
| `DISCORD_DM_POLICY` | Discord DM policy (passed through to machine) |
| `OPENCLAW_ALLOWED_ORIGINS` | Comma-separated origins for Control UI WebSocket (e.g., `http://localhost:3000,http://localhost:8795`). Production: `https://claw.kilo.ai,https://claw.kilosessions.ai`. Per-instance `<scheme>://<label><suffix>` origins are appended at machine build time from `KILOCLAW_INSTANCE_HOST_SUFFIX` + `KILOCLAW_INSTANCE_URL_SCHEME`. |
| `KILOCLAW_INSTANCE_HOST_SUFFIX` | Host suffix for per-instance virtual hosting. Prod default in `wrangler.jsonc` is `.kiloclaw.ai`. No silent fallback — an unset value causes request-path code to throw (and `validateRequiredEnv` returns 503). |
| `KILOCLAW_INSTANCE_URL_SCHEME` | URL scheme paired with `KILOCLAW_INSTANCE_HOST_SUFFIX`. Prod default `https`. For dev-parity, set to `http` with a `:port`-bearing suffix like `.kiloclaw.localhost:8795`. |

### Fly.io Regions

Volumes are region-pinned. Once a user's volume is created in a region, their machine always starts there. `FLY_REGION` accepts a comma-separated priority list (e.g., `us,eu`) -- Fly tries the first region/alias, falls back to the next if unavailable. Geographic aliases (`us`, `eu`, `sa`) expand to all regions in that area. See [Fly regions docs](https://fly.io/docs/reference/regions/) for the full list.

## Commands

```bash
pnpm typecheck        # tsgo
pnpm lint             # oxlint
pnpm format           # oxfmt
pnpm test             # vitest (node)
pnpm types            # regenerate worker-configuration.d.ts (run after changing wrangler.jsonc)
pnpm start            # wrangler dev
```

## Controller Smoke Scripts

When working on machine-side controller behavior, use the Docker smoke scripts in
`scripts/` (build image first: `docker buildx build --build-context workspace=../.. --load -t kiloclaw:controller .`):

- `scripts/controller-smoke-test.sh`
  - Fresh container (onboard path). Tests auth, env patch, version endpoints.
  - Best for quick auth/proxy sanity checks.
- `scripts/controller-entrypoint-smoke-test.sh`
  - Volume-mounted container with pre-seeded config (doctor path).
  - Best for startup/Docker integration changes.
- `scripts/controller-proxy-auth-smoke-test.sh`
  - Confirms proxy-token enforcement semantics (`401` without token, pass-through with token).
  - Best for proxy auth and routing-order validation.

## Change Checklist

Before submitting any change:

1. Run `pnpm typecheck && pnpm test && pnpm lint`
2. Update tests in the same PR -- do not defer
3. Do not reintroduce optional `userId` or `sandboxId` parameters (they are always required)
4. If changing bootstrap behavior, update `controller/src/bootstrap.ts` and its tests
5. If adding or changing user-facing features, add a changelog entry to `src/app/(app)/claw/components/changelog-data.ts` (newest first)
6. If adding a new route that resolves a KiloClawInstance DO stub, accept optional `?instanceId=` and use it as the DO key when present (see "Multi-Instance Migration" section)

## Test Targets by Change Type

| What you changed | Test files to update |
|---|---|
| Auth middleware, JWT, pepper | `src/auth/middleware.test.ts`, `src/auth/jwt.test.ts` |
| Gateway env var building | `src/gateway/env.test.ts` |
| Fly API client | `src/fly/client.test.ts` |
| Fly Apps / IP allocation | `src/fly/apps.test.ts` |
| Fly App Secrets | `src/fly/secrets.test.ts` |
| App DO (per-user Fly App lifecycle) | `src/durable-objects/kiloclaw-app.test.ts` |
| DO lifecycle, reconciliation, destroy | `src/durable-objects/kiloclaw-instance.test.ts` |
| RSA+AES envelope encryption | `src/utils/encryption.test.ts` |
| Env var encryption (AES-256-GCM) | `src/utils/env-encryption.test.ts` |
| Sandbox ID derivation | `src/auth/sandbox-id.test.ts` |
| Gateway token derivation | `src/auth/gateway-token.test.ts` |

## Multi-Instance Migration (In Progress)

KiloClaw is transitioning from one-instance-per-user to N-instances-per-owner (personal + org). This affects how you write new code:

### Identity model

| Concept | Legacy (current default) | Multi-instance (new path) |
|---|---|---|
| **DO key** | `idFromName(userId)` | `idFromName(instanceId)` where `instanceId` = `kiloclaw_instances.id` UUID |
| **sandboxId** | `sandboxIdFromUserId(userId)` — base64url, reversible | `sandboxIdFromInstanceId(instanceId)` → `ki_{uuid-no-dashes}` (35 chars) |
| **Proxy route** | Catch-all `/*` | `/i/:instanceId/*` |
| **Ownership** | Implicit (DO keyed by authed userId) | Explicit check: `status.userId === authed userId` |

### What to know when making changes

- **All platform/user/admin routes accept optional `?instanceId=`**. When present, it's used as the DO key instead of userId. When absent, legacy userId-keyed behavior applies. If you add a new route that resolves a DO stub, follow this pattern.
- **The `ki_` prefix on sandboxIds is load-bearing.** It distinguishes instance-keyed sandboxIds from legacy ones. Gateway token derivation, Fly metadata recovery, and volume naming all key off sandboxId. Do not remove or change the prefix scheme.
- **`orgId` is threaded through DO state and env vars.** The DO persists `orgId`, and `buildEnvVars` injects `KILOCODE_ORGANIZATION_ID` when present. If you add new env var logic, account for org instances.
- **Ownership checks are required on user-facing routes that accept `instanceId`.** The `/i/:instanceId/*` proxy route, `kiloclaw.ts` routes, and `api.ts` admin routes all verify `status.userId === authenticated userId` before allowing access. New routes must do the same.
- **The Instance DO `provision()` method accepts `opts.instanceId` and `opts.orgId`.** When `instanceId` is provided, sandboxId is derived from it instead of userId. When `orgId` is provided, it's persisted in DO state and injected as an env var.
- **Postgres `kiloclaw_instances.id` IS the instanceId.** There is no separate `instance_id` column. The existing UUID primary key is the routing identity.
- **Row creation is Worker-driven.** Provision flows call the Worker's platform route, which inserts the `kiloclaw_instances` row and returns the `id`. `ensureActiveInstance()` in Next.js is now a read-through helper that returns the existing row; it does not create rows. See `.specs/kiloclaw-datamodel.md` rule 21.

### Current multi-instance control plane

- **KiloClawRegistry DO** — SQLite-backed DO that indexes instances per owner (`user:{userId}` or `org:{orgId}`) for routing. Fresh-provision admission reservations are being added as a separate non-routable state surface; never expose pending reservations from normal route-resolution methods.
- **Org instances** — `organization_id` links instances to org contexts. Registry entries for an organization may contain several assigned users; any current one-active-instance admission rule must be qualified by assigned user rather than treating the whole organization as one slot.

## Code Style

- See `/.kilocode/rules/coding-style.md` for project-wide rules
- Prefer `type` over `interface`
- Avoid `as` and `!` -- use `satisfies` or flow-sensitive typing
- No mocks where avoidable -- assert on results

## Gateway Configuration

OpenClaw configuration is built at machine startup by the controller's bootstrap module (`controller/src/bootstrap.ts`):

1. Decrypt `KILOCLAW_ENC_*` env vars using `KILOCLAW_ENV_KEY` (Fly app secret)
2. If no config exists (first boot), `openclaw onboard --non-interactive` creates one
3. The bootstrap patches the config for channels, gateway auth, and KiloCode provider
4. Key material (`KILOCLAW_ENV_KEY`, `KILOCLAW_ENC_*`) is deleted from `process.env`
5. The controller's supervisor starts the gateway with `openclaw gateway --allow-unconfigured --bind loopback`

Config and workspace persist across machine restarts via the Fly Volume at `/root`.

### Env Var Encryption

Sensitive env var values are AES-256-GCM encrypted by the worker before placement in Fly machine `config.env`. This prevents exposure via the Fly API (e.g., `getMachine` responses) and the Fly control plane.

- Per-user AES-256 key generated by `KiloClawApp.ensureEnvKey()`, stored as Fly app secret `KILOCLAW_ENV_KEY`
- Sensitive vars stored under `KILOCLAW_ENC_` prefix: e.g., `KILOCLAW_ENC_KILOCODE_API_KEY=enc:v1:{base64}`
- Non-sensitive vars stored with normal names (e.g., `AUTO_APPROVE_DEVICES=true`)
- The controller's bootstrap decrypts at boot, strips prefix, sets plaintext env vars
- Fail closed: missing key with `KILOCLAW_ENC_*` vars present aborts startup
- Post-decrypt presence check requires `KILOCODE_API_KEY` and `OPENCLAW_GATEWAY_TOKEN`
- `min_secrets_version` passed to `createMachine`/`updateMachine` to ensure the Fly secret is propagated before the machine boots

### Env Var Transport

User config is transported to the machine via environment variables set in the Fly machine config. Sensitive values are encrypted (see above). The controller's bootstrap decrypts and patches the openclaw config file.

**Encrypted (stored as `KILOCLAW_ENC_{name}`, decrypted to `{name}` at boot):**

| Env var (after decrypt) | Source | Purpose |
|---|---|---|
| `KILOCODE_API_KEY` | User config (DO) | KiloCode API authentication |
| `OPENCLAW_GATEWAY_TOKEN` | Derived from sandboxId | Per-user gateway auth |
| `TELEGRAM_BOT_TOKEN` | Decrypted channel token | Telegram channel |
| `DISCORD_BOT_TOKEN` | Decrypted channel token | Discord channel |
| `SLACK_BOT_TOKEN` | Decrypted channel token | Slack channel |
| `SLACK_APP_TOKEN` | Decrypted channel token | Slack channel |
| User encrypted secrets | Decrypted from RSA envelopes | User-provided credentials |

**Plaintext (stored as-is in config.env):**

| Env var | Source | Purpose |
|---|---|---|
| `KILOCODE_DEFAULT_MODEL` | User config (DO) | Default model for agents |
| `KILOCODE_MODELS_JSON` | User config (DO), JSON-serialized | Available model list |
| `KILOCODE_API_BASE_URL` | Worker env | API base URL override |
| `AUTO_APPROVE_DEVICES` | Hardcoded `true` | Skip device pairing |
| `TELEGRAM_DM_POLICY` | Worker env | Telegram DM policy |
| `DISCORD_DM_POLICY` | Worker env | Discord DM policy |
| `OPENCLAW_ALLOWED_ORIGINS` | Worker env | Control UI WebSocket allowed origins |

### AI Provider Selection

KiloClaw is KiloCode-only:

1. `KILOCODE_API_KEY` is required at startup.
2. The controller's bootstrap patches `config.models.providers.kilocode`.
3. `agents.defaults.model.primary` is set from `KILOCODE_DEFAULT_MODEL` (or fallback default).
4. Model list is read from `KILOCODE_MODELS_JSON` env var (preferred), falling back to file at `/root/.openclaw/kilocode-models.json`, then baked-in defaults.

## OpenClaw Config Schema

OpenClaw has strict config validation. Common gotchas:

- `agents.defaults.model` must be `{ "primary": "provider/model-id" }` not a string
- `gateway.mode` must be `"local"` for headless operation
- No `webchat` channel -- the Control UI is served automatically by the gateway
- `gateway.bind` is not a config option -- use `--bind` CLI flag

## Docker Image

The Dockerfile is based on `debian:bookworm-slim` and installs Node.js 24 + OpenClaw.
The image is pushed to Fly's registry (`registry.fly.io/{FLY_APP_NAME}`) via CI.

The Dockerfile has two cache bust mechanisms:

- **Controller build layer**: Use `--build-arg CONTROLLER_CACHE_BUST=$(date +%s)` to force a controller rebuild.
- **COPY layers** (helper scripts, skills, etc.): Increment the number in the `RUN echo "N"` line and update the adjacent `# Build cache bust:` comment. This invalidates Docker's layer cache for all subsequent COPY instructions.

### Files COPYed into the image

These files are COPYed by the Dockerfile and hashed by CI (`deploy-kiloclaw.yml`) to
produce the content-hash image tag. If you add or remove a COPY in the Dockerfile,
update the `find` command in the workflow's "Compute source content hash" step to match.

| Path | Purpose |
|---|---|
| `Dockerfile` | Base image, apt packages, npm versions |
| `controller/` | Compiled to `kiloclaw-controller.js` (entrypoint) |
| `container/` | Runtime assets (e.g. `TOOLS.md`) staged outside `/root` |
| `plugins/kiloclaw-customizer/` | KiloClaw customizer plugin package installed in image |
| `plugins/kilo-chat/` | Kilo Chat channel plugin package installed in image |
| `plugins/kiloclaw-morning-briefing/` | Morning briefing plugin package installed in image |
| `openclaw-pairing-list.js` | Helper script used at runtime by controller |
| `openclaw-device-pairing-list.js` | Helper script used at runtime by controller |
| `skills/` | Custom skills copied to `/root/clawd/skills/` |

## Fly Machine Lifecycle

| Operation | What happens |
|---|---|
| **Provision** | Creates a Fly Volume in the configured region. Stores config in DO. Schedules reconciliation alarm. |
| **Start** | Ensures volume exists. Creates a Fly Machine (or starts an existing stopped one) with volume mounted at `/root`, metadata tags, and env vars. Persists machine ID immediately. Schedules health check alarm. |
| **Stop** | Stops the Fly Machine via API. Volume persists. Alarm continues at idle cadence. |
| **Restart** | Stops machine, updates config (env vars, image, metadata), starts it. Volume persists. |
| **Restore** | Enqueues a CF Queue job, sets status to `restoring`. Queue worker: stops machine, destroys it (releases volume attachment), creates new volume from snapshot, swaps DO state, creates fresh machine. Old volume retained for revert. |
| **Destroy** | Two-phase: persists pending IDs + `status='destroying'`, attempts Fly deletions, only clears DO state when both confirmed. Alarm retries failures. |
| **Reconciliation** | Alarm runs for all statuses. Running: 5 min. Destroying: 1 min. Restoring: 1 min (no-op, stuck detection only). Idle (provisioned/stopped): 30 min. Fixes status drift, missing volumes, stale machine IDs, wrong mounts, and recovers lost IDs from Fly metadata. |

## Metadata Recovery

Each Fly Machine is tagged with `kiloclaw_user_id` and `kiloclaw_sandbox_id` metadata. When the DO has no `flyMachineId` (e.g., after a DO wipe + Postgres restore), the reconciliation alarm queries Fly's list machines endpoint filtered by `metadata.kiloclaw_user_id`. Selection is deterministic: prefer `started` > `starting` > `stopped` > `created`, tie-break by newest `updated_at`. Volume ID is recovered from the machine's mount config. A cooldown prevents hammering the Fly API when there's genuinely nothing to recover.

## Security Model

- CF Worker handles all auth (JWT, API keys, gateway tokens)
- Fly Proxy is not authenticated -- anyone can reach `{app}.fly.dev`
- Protection layers: machine IDs are opaque + openclaw gateway validates per-user HMAC gateway token
- Future: sidecar proxy on each machine for defense-in-depth

## Default Machine Spec

`shared-cpu-2x`, 4GB RAM (~$21.54/mo when running, free when stopped). Configurable per-user via `machineSize` in the provision API.
