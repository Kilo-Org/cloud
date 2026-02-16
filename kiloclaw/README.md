# KiloClaw

Multi-tenant OpenClaw on Fly.io Machines, orchestrated by a Cloudflare Worker.

## Architecture

```
Browser → CF Worker (claw.kilo.ai)
            │ JWT auth, derive userId → look up flyMachineId from DO
            │ add fly-force-instance-id header
            ↓
         Fly Proxy ({FLY_APP_NAME}.fly.dev, TLS)
            │ routes to pinned machine
            ↓
         Fly Machine (openclaw gateway on port 18789)
            │ Fly Volume mounted at /root (persistent storage)
```

Each authenticated user gets a dedicated Fly Machine running an OpenClaw gateway. The CF Worker handles auth, config management, and proxies HTTP/WebSocket traffic to each user's machine via Fly Proxy.

## The Durable Object as Coordination Atom

The **KiloClawInstance Durable Object** is the coordination primitive for each user's instance. Every mutation (provision, start, stop, destroy) and every state read (status, config, machine ID) is serialized through a single DO, keyed by `userId`.

This gives us:

- **Single-writer semantics** — No two concurrent requests can race to create a machine or double-destroy a volume. The DO's single-threaded execution model prevents it.
- **Authoritative state** — The DO is the source of truth for `flyMachineId`, `flyVolumeId`, status, pending-destroy IDs, and health check counters. Fly is the source of truth for whether the machine is actually running, but the DO decides what the system should do about it.
- **Self-healing via alarm** — The reconciliation loop is co-located with the state it repairs. There is no external cron or central reconciler — each DO independently detects and fixes drift for its own instance.
- **Proxy routing** — The catch-all in `index.ts` resolves `flyMachineId` from the DO before forwarding to Fly Proxy. The DO is the routing index.

State that lives outside the DO:

| Location         | Role                              | Authority                                                       |
| ---------------- | --------------------------------- | --------------------------------------------------------------- |
| **Postgres**     | Registry + config backup          | Next.js is sole writer; worker reads only for restore           |
| **Fly metadata** | Recovery index                    | Written at machine creation; queried only when DO state is lost |
| **Fly itself**   | Actual compute + volume resources | Ground truth for machine/volume existence and state             |

All three are fallback/recovery paths. The DO is the atom.

## Reconciliation

The alarm loop runs for all live instances (provisioned, running, stopped, destroying) and fixes drift between DO state and Fly reality:

- **Destroying**: Only retries pending resource deletions. Never recreates anything.
- **Missing volume**: Auto-creates a replacement (with data-loss warning log).
- **Missing machine (404)**: Clears stale ID, marks instance stopped.
- **Status mismatch**: Syncs DO status to match Fly machine state.
- **Wrong mount**: Repairs via stop → update config → start.
- **Lost DO state**: Recovers machine/volume IDs from Fly metadata tags.

Alarm cadence varies by status: 5 min (running), 1 min (destroying), 30 min (idle).

## Two-Phase Destroy

Destroy is failure-safe:

1. Persist `pendingDestroyMachineId` + `pendingDestroyVolumeId` + `status='destroying'`
2. Attempt Fly deletions (treat 404 as success)
3. Only `deleteAll()` when **both** IDs are confirmed cleared
4. If either fails, alarm retries cleanup

This prevents orphaning resources on transient Fly API errors.

## Commands

```bash
pnpm typecheck        # type checking via tsgo
pnpm lint             # eslint
pnpm test             # vitest
pnpm format           # prettier
pnpm start            # wrangler dev
```

## Environment

See `.dev.vars.example` for required environment variables. Key ones:

- `FLY_API_TOKEN` — Bearer token for Fly Machines API
- `FLY_APP_NAME` — Fly App hosting all user machines
- `FLY_REGION` — Default region (comma-separated priority list, e.g., `us,eu`)
- `NEXTAUTH_SECRET` — JWT verification (shared with Next.js)
- `GATEWAY_TOKEN_SECRET` — Per-user gateway token HMAC secret

See [AGENTS.md](./AGENTS.md) for the full architecture map, file structure, and development guidelines.
