# KiloClaw

Multi-tenant OpenClaw runtimes, orchestrated by a Cloudflare Worker.

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

Each authenticated user gets a dedicated provider-backed runtime running an OpenClaw gateway. In production today that runtime is a Fly Machine. In local development, `docker-local` can provision Docker containers on the developer machine. The CF Worker handles auth, config management, and proxies HTTP/WebSocket traffic to each user's runtime.

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
pnpm lint             # oxlint
pnpm test             # vitest
pnpm format           # oxfmt
pnpm start            # wrangler dev
```

## Docker-Local Provider

`docker-local` is a development-only provider that lets `wrangler dev` provision one or more KiloClaw instances as Docker containers on your machine. It uses the same controller image and injects the same runtime env vars as Fly, but routes through a host port instead of the Fly proxy.

1. Expose the local Docker socket over loopback for Wrangler:

   ```bash
   socat TCP-LISTEN:23750,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/var/run/docker.sock
   ```

2. Build the local KiloClaw runtime image from this directory:

   ```bash
   cd services/kiloclaw
   ./scripts/build-local-image.sh
   ```

   The script reads `DOCKER_LOCAL_IMAGE` from `.dev.vars` when present and defaults to `kiloclaw:local`. To build against a local OpenClaw package tarball, place `openclaw-*.tgz` under `services/kiloclaw/openclaw-build/` and run:

   ```bash
   ./scripts/build-local-image.sh --local
   ```

3. Update `services/kiloclaw/.dev.vars` after it has been created by `pnpm dev:env` or `./scripts/dev-start.sh`:

   ```bash
   WORKER_ENV=development
   KILOCLAW_DEFAULT_PROVIDER=docker-local
   DOCKER_LOCAL_API_BASE=http://127.0.0.1:23750
   DOCKER_LOCAL_IMAGE=kiloclaw:local
   DOCKER_LOCAL_PORT_RANGE=45000-45999
   ```

   `DOCKER_LOCAL_API_BASE` should be an origin only, without a Docker API version path such as `/v1.44`.

4. Start KiloClaw locally:

   ```bash
   pnpm start
   ```

   New provisions without an explicit provider use `KILOCLAW_DEFAULT_PROVIDER`. You can also pass `provider: "docker-local"` to the platform provision endpoint when you want Fly to remain the default.

Rebuild the image after controller or Dockerfile changes, then restart or redeploy the instance so the container is recreated with the new image/env/config. A plain `start` leaves an already-running docker-local container intact.

## Environment

See `.dev.vars.example` for required environment variables. Key ones:

- `FLY_API_TOKEN` — Bearer token for Fly Machines API
- `FLY_APP_NAME` — Fly App hosting all user machines
- `FLY_REGION` — Default region (comma-separated priority list, e.g., `us,eu`)
- `KILOCLAW_DEFAULT_PROVIDER` — Local default provider (`fly` or `docker-local`)
- `DOCKER_LOCAL_API_BASE` — Loopback Docker HTTP bridge for `docker-local`
- `DOCKER_LOCAL_IMAGE` — Local image tag used by `docker-local`
- `NEXTAUTH_SECRET` — JWT verification (shared with Next.js)
- `GATEWAY_TOKEN_SECRET` — Per-user gateway token HMAC secret

See [AGENTS.md](./AGENTS.md) for the full architecture map, file structure, and development guidelines.
