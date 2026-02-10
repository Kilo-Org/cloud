# AGENTS.md

## What This Is

KiloClaw is a Cloudflare Worker that runs OpenClaw AI assistant instances inside Cloudflare Sandbox containers. It proxies HTTP/WebSocket traffic to the OpenClaw gateway running inside the container.

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Routing**: Hono
- **Containers**: `@cloudflare/sandbox` (Durable Object-backed containers)
- **Durable Objects**: RPC-style (not fetch-based) — use typed stubs, not `fetch()`
- **Storage**: R2 (mounted via s3fs inside containers at `/data/openclaw`)
- **Database**: Hyperdrive (Postgres) — not yet wired, coming in a future PR
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
# Build cache bust: 2026-02-06-v28-openclaw-upgrade
```

## R2 Storage Gotchas

R2 is mounted via s3fs at `/data/openclaw`:

- **rsync**: Use `rsync -r --no-times` not `rsync -a`. s3fs doesn't support setting timestamps.
- **Mount checking**: Don't rely on `sandbox.mountBucket()` errors. Check `mount | grep s3fs` instead.
- **Never delete R2 data**: `/data/openclaw` IS the R2 bucket. `rm -rf` will delete backup data.
- **Process status**: `proc.status` may lag. Verify success by checking expected output, not status field.

## WebSocket Limitations

Local `wrangler dev` has issues proxying WebSocket connections through the sandbox. HTTP works but WebSocket may fail. Deploy to Cloudflare for full functionality.
