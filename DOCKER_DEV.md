# Docker-based Local Development

Run the entire monorepo (Next.js backend + all Cloudflare Workers + PostgreSQL) with a single command instead of managing ~16 terminal windows.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Docker Desktop (macOS/Windows) / Docker Engine (Linux) | 4.x+ | `docker --version` |
| Docker Compose v2 | 2.20+ | `docker compose version` |
| pnpm | 10.27.0 | `pnpm --version` |
| Node.js | ^22 | `node --version` |

> **Note:** `pnpm install` must be run at least once before starting — the Docker containers mount the repo and expect `node_modules` to exist.

## Quick Start

```bash
# Install dependencies (if not already done)
pnpm install

# Start everything
./dev/dev.sh

# Or directly with docker compose
docker compose -f dev/docker-compose.dev.yml --profile all up
```

## Profiles

Services are grouped into profiles for selective startup. PostgreSQL always starts (no profile required).

| Profile | Services |
|---------|----------|
| `core` | PostgreSQL + Next.js backend |
| `agents` | PostgreSQL + cloud-agent + cloud-agent-next |
| `workers` | PostgreSQL + cloud-agent + all Cloudflare Workers |
| `all` | Everything |

```bash
# Core only (postgres + nextjs)
./dev/dev.sh --profile core up

# Core + agents
./dev/dev.sh --profile core --profile agents up

# Everything
./dev/dev.sh                    # defaults to --profile all
./dev/dev.sh --profile all up

# Specific services by name
docker compose -f dev/docker-compose.dev.yml up postgres nextjs cloud-agent
```

## Port Map

| Service | Port | Directory |
|---------|------|-----------|
| PostgreSQL | 5432 | — |
| Next.js backend | 3000 | `.` (root) |
| cloud-agent | 8788 | `cloud-agent/` |
| cloudflare-ai-attribution | 8787 | `cloudflare-ai-attribution/` |
| cloudflare-code-review-infra | 8789 | `cloudflare-code-review-infra/` |
| cloudflare-app-builder | 8790 | `cloudflare-app-builder/` |
| cloudflare-auto-triage-infra | 8791 | `cloudflare-auto-triage-infra/` |
| cloudflare-webhook-agent-ingest | 8793 | `cloudflare-webhook-agent-ingest/` |
| cloud-agent-next | 8794 | `cloud-agent-next/` |
| kiloclaw | 8795 | `kiloclaw/` |
| cloudflare-auto-fix-infra | 8796 | `cloudflare-auto-fix-infra/` |
| cloudflare-db-proxy | 8797 | `cloudflare-db-proxy/` |
| cloudflare-deploy-builder | 8798 | `cloudflare-deploy-infra/builder/` |
| cloudflare-deploy-dispatcher | 8799 | `cloudflare-deploy-infra/dispatcher/` |
| cloudflare-session-ingest | 8800 | `cloudflare-session-ingest/` |
| cloudflare-o11y | 8801 | `cloudflare-o11y/` |
| cloudflare-git-token-service | 8802 | `cloudflare-git-token-service/` |

> Ports are overridden via `--port` in the wrangler dev command to avoid conflicts between workers that share the same default port in their `wrangler.jsonc`.

## Networking

All services share the default Docker Compose bridge network. Services reach each other by their Compose service name (e.g., `postgres`, `nextjs`, `cloud-agent`) via Docker's built-in DNS — no `network_mode: host` needed, so this works on both **macOS** (Docker Desktop) and **Linux**.

### How inter-service URLs are resolved

The wrangler.jsonc files in each worker hardcode `localhost` for inter-service URLs (e.g., `KILOCODE_BACKEND_BASE_URL: "http://localhost:3000"`, Hyperdrive `localConnectionString: "postgres://...@localhost:5432/..."`). Inside Docker containers on a bridge network, `localhost` refers to the container itself, not other services.

To fix this without modifying the shared wrangler.jsonc files:

- **Wrangler workers** use [`dev/docker-wrangler-entrypoint.sh`](dev/docker-wrangler-entrypoint.sh) which creates a temporary patched copy of `wrangler.jsonc` at startup, replacing `localhost` references with Docker service names (e.g., `localhost:3000` → `nextjs:3000`, `localhost:5432` → `postgres:5432`).
- **Next.js** overrides env vars directly via the `environment:` key in docker-compose (e.g., `POSTGRES_URL`, `CLOUD_AGENT_API_URL`), which take precedence over values in `.env`.

### Accessing services from the host

From your host machine, services are still accessible at `localhost:<port>` via Docker's port forwarding (the `ports:` mappings in docker-compose).

## Environment Variables

### Next.js backend

The Next.js service loads `env_file: ../.env` (repo root `.env`). Make sure this file exists:

```bash
# If you have an .env.example, copy it
cp .env.example .env
# Then fill in the required values
```

The docker-compose file overrides `POSTGRES_URL`, `CLOUD_AGENT_API_URL`, and `WEBHOOK_AGENT_URL` to use Docker service names. You don't need to set these in `.env` for Docker dev.

### Cloudflare Workers

Workers that need secrets use `.dev.vars` files in their respective directories. Copy the examples:

```bash
# Example for cloud-agent
cp cloud-agent/.dev.vars.example cloud-agent/.dev.vars

# Workers with .dev.vars.example files:
# cloud-agent, cloud-agent-next, cloudflare-app-builder,
# cloudflare-auto-fix-infra, cloudflare-auto-triage-infra,
# cloudflare-code-review-infra, cloudflare-db-proxy,
# cloudflare-deploy-infra/builder, cloudflare-deploy-infra/dispatcher,
# cloudflare-git-token-service, cloudflare-webhook-agent-ingest,
# kiloclaw
```

> **Note:** You do NOT need to change `localhost` references in `.dev.vars` files for Docker — the entrypoint script handles URL rewriting automatically via the wrangler.jsonc patching.

## Architecture

- **Shared Docker image** (`dev/Dockerfile.dev`): `node:22.14.0-slim` with pnpm, wrangler, and bun pre-installed.
- **Volume mount**: The entire repo is mounted at `/app` — file changes are reflected immediately (hot reload works).
- **Port mappings**: Each service exposes its port via explicit `ports:` mappings, which works on both macOS (Docker Desktop) and Linux.
- **Inter-service networking**: Docker Compose bridge network with DNS-based service discovery. See [Networking](#networking) above.
- **Existing `dev/docker-compose.yml`** is untouched — it continues to work standalone for PostgreSQL-only usage.

## Docker Socket Mount (Container-backed Durable Objects)

Four workers use Cloudflare's [container-backed Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/#container-durable-objects), which require Docker to spawn sandbox containers at runtime via Wrangler:

- `cloud-agent`
- `cloud-agent-next`
- `cloudflare-app-builder`
- `cloudflare-deploy-builder`

Because these workers already run inside Docker containers, they can't use Docker natively (Docker-in-Docker). Instead, the host's Docker socket is mounted into these containers:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

This lets Wrangler inside the container talk to the host's Docker daemon to create sibling containers.

### Security implications

Mounting the Docker socket gives the container **full, unrestricted access to the host's Docker daemon** — equivalent to root access on the host. This is acceptable for local development but must **never** be used in production or CI environments with untrusted code. The mount is only applied to the four workers listed above; all other services use the default volume configuration from the shared base.

## Troubleshooting

### Port already in use

If a service fails with `EADDRINUSE`, another process is already using that port. Check with:

```bash
lsof -i :<port>
```

### Worker fails to start

Some workers (cloud-agent, cloud-agent-next) have `predev` scripts that build a wrapper using `bun`. The Docker image includes bun, but if you see build errors, try:

```bash
# Rebuild the Docker image
docker compose -f dev/docker-compose.dev.yml build --no-cache
```

### node_modules issues

The containers mount the host's `node_modules`. If you see missing dependency errors:

```bash
pnpm install
# Then restart the containers
docker compose -f dev/docker-compose.dev.yml --profile all restart
```

### Inter-service connection refused

If a worker can't reach another service (e.g., `ECONNREFUSED` to `nextjs:3000`), make sure the target service is running. Check with:

```bash
docker compose -f dev/docker-compose.dev.yml ps
```

Services only start if their profile is active. For example, `cloud-agent` requires the `agents` or `all` profile.

### Viewing logs for a single service

```bash
docker compose -f dev/docker-compose.dev.yml logs -f nextjs
docker compose -f dev/docker-compose.dev.yml logs -f cloud-agent
```

### Stopping everything

```bash
docker compose -f dev/docker-compose.dev.yml --profile all down

# Also remove the postgres volume if you want a fresh database
docker compose -f dev/docker-compose.dev.yml --profile all down -v
```
