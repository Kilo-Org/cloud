# AGENTS.md

## What This Is

KiloClaw is a Cloudflare Worker that runs per-user OpenClaw AI assistant instances inside Cloudflare Sandbox containers. It proxies HTTP/WebSocket traffic to the OpenClaw gateway running inside each user's container.

## Hard Invariants

These are non-negotiable. Do not reintroduce shared/fallback paths.

- **No shared mode.** Every request, DO, and container is user-scoped. There is no global sandbox, no shared-sandbox fallback, no optional userId parameters.
- **User scoping.** DOs are keyed by `idFromName(userId)`. Sandbox containers are keyed by `sandboxIdFromUserId(userId)`. Both are deterministic and reversible.
- **R2 is always per-user.** `mountR2Storage` requires a `userId` and always mounts with a per-user prefix (`/users/{sha256(userId)}`). There is no unprefixed/root mount path.
- **`buildEnvVars` requires `sandboxId` and `gatewayTokenSecret`.** Gateway token and `AUTO_APPROVE_DEVICES` are always set. No fallback to worker-level channel tokens.
- **`ensureOpenClawGateway` requires pre-built env vars.** Callers build env vars via `buildEnvVars`, mount R2, then call `ensureOpenClawGateway`. The function does not build env vars itself.
- **Postgres is a registry, not operational state.** The DB stores `(user_id, sandbox_id, created_at, destroyed_at)`. Status, timestamps, and config live in the DO. No `mirrorStatusToDb`.

## Architecture Map

```
src/
├── index.ts                          # Hono app, middleware chain, catch-all proxy
├── routes/
│   ├── api.ts                        # /api/admin/* (DO RPC wrappers)
│   ├── kiloclaw.ts                   # /api/kiloclaw/* (user-facing, JWT auth)
│   ├── platform.ts                   # /api/platform/* (internal API key auth)
│   ├── debug.ts                      # /debug/* (operator tools, ?sandboxId= param)
│   └── public.ts                     # /health (no auth)
├── auth/
│   ├── middleware.ts                  # JWT auth + pepper validation via Hyperdrive
│   ├── jwt.ts                        # Token parsing/verification
│   ├── gateway-token.ts              # HMAC-SHA256 derivation for per-sandbox tokens
│   ├── sandbox-id.ts                 # userId <-> sandboxId (base64url, reversible)
│   └── debug-gate.ts                 # Debug route access control
├── durable-objects/
│   └── kiloclaw-instance.ts          # DO: lifecycle state machine, config store, alarm sync
├── gateway/
│   ├── env.ts                        # buildEnvVars: 5-layer env var pipeline
│   ├── process.ts                    # ensureOpenClawGateway, findExistingGatewayProcess
│   ├── r2.ts                         # mountR2Storage (per-user prefix), userR2Prefix
│   └── sync.ts                       # syncToR2: rsync config/workspace to R2
├── utils/
│   └── encryption.ts                 # RSA+AES envelope decryption (secrets, channels)
├── schemas/
│   └── instance-config.ts            # Zod schemas for DO persisted state
├── db/
│   └── stores/InstanceStore.ts       # Postgres registry (insert, markDestroyed, find)
├── sandbox.ts                        # KiloClawSandbox subclass (onStop lifecycle hook)
├── config.ts                         # Constants (ports, paths, timeouts)
└── types.ts                          # KiloClawEnv, AppEnv
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Routing**: Hono
- **Containers**: `@cloudflare/sandbox` (Durable Object-backed containers)
- **Durable Objects**: RPC-style (not fetch-based) — use typed stubs, not `fetch()`
- **Storage**: R2 (mounted via s3fs inside containers at `/data/openclaw`, per-user prefix)
- **Database**: Hyperdrive (Postgres) for pepper validation and instance registry
- **Auth**: `jose` for JWT verification

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
2. Update tests in the same PR — do not defer
3. Do not reintroduce optional `userId` or `sandboxId` parameters (they are always required)
4. If changing `start-openclaw.sh`, bump the cache bust in the Dockerfile

## Test Targets by Change Type

| What you changed             | Test files to update                                  |
| ---------------------------- | ----------------------------------------------------- |
| Auth middleware, JWT, pepper | `src/auth/middleware.test.ts`, `src/auth/jwt.test.ts` |
| Gateway env var building     | `src/gateway/env.test.ts`                             |
| R2 mount / prefix            | `src/gateway/r2.test.ts`                              |
| Sync to R2                   | `src/gateway/sync.test.ts`                            |
| Gateway process lifecycle    | `src/gateway/process.test.ts`                         |
| Encryption / decryption      | `src/utils/encryption.test.ts`                        |
| Debug route gating           | `src/auth/debug-gate.test.ts`                         |
| Sandbox ID derivation        | `src/auth/sandbox-id.test.ts`                         |
| Gateway token derivation     | `src/auth/gateway-token.test.ts`                      |

## Code Style

- See `/.kilocode/rules/coding-style.md` for project-wide rules
- Prefer `type` over `interface`
- Avoid `as` and `!` — use `satisfies` or flow-sensitive typing
- No mocks where avoidable — assert on results

## Gateway Configuration

OpenClaw configuration is built at container startup by `start-openclaw.sh`:

1. R2 backup is restored if available (with migration from legacy `.clawdbot` paths)
2. If no config exists, `openclaw onboard --non-interactive` creates one based on env vars
3. The startup script patches the config for channels, gateway auth, and trusted proxies
4. Gateway starts with `openclaw gateway --allow-unconfigured --bind lan`

### AI Provider Priority

The startup script selects the provider based on which env vars are set:

1. **Cloudflare AI Gateway** (native): `CLOUDFLARE_AI_GATEWAY_API_KEY` + `CF_AI_GATEWAY_ACCOUNT_ID` + `CF_AI_GATEWAY_GATEWAY_ID`
2. **Direct Anthropic**: `ANTHROPIC_API_KEY` (optionally with `ANTHROPIC_BASE_URL`)
3. **Direct OpenAI**: `OPENAI_API_KEY`
4. **Legacy AI Gateway**: `AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL`

## OpenClaw Config Schema

OpenClaw has strict config validation. Common gotchas:

- `agents.defaults.model` must be `{ "primary": "provider/model-id" }` not a string
- `gateway.mode` must be `"local"` for headless operation
- No `webchat` channel — the Control UI is served automatically by the gateway
- `gateway.bind` is not a config option — use `--bind` CLI flag

## Docker Image Caching

The Dockerfile includes a cache bust comment. When changing `start-openclaw.sh`, bump the version:

```dockerfile
# Build cache bust: 2026-02-10-v30-openclaw-upgrade
```

## R2 Storage Gotchas

R2 is mounted via s3fs at `/data/openclaw` with a per-user prefix:

- **Always per-user.** `mountR2Storage(sandbox, env, userId)` — userId is required. The SDK handles mount idempotency.
- **rsync**: Use `rsync -r --no-times` not `rsync -a`. s3fs doesn't support setting timestamps.
- **Never delete R2 data**: `/data/openclaw` IS the R2 bucket (scoped by prefix). `rm -rf` will delete backup data.
- **Process status**: `proc.status` may lag. Verify success by checking expected output, not status field.

## WebSocket Limitations

Local `wrangler dev` has issues proxying WebSocket connections through the sandbox. HTTP works but WebSocket may fail. Deploy to Cloudflare for full functionality.
