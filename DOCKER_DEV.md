# Docker-based Local Development

Run the entire monorepo (Next.js backend + all Cloudflare Workers + PostgreSQL) with a single command instead of managing ~16 terminal windows.

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Docker | 20.10+ | `docker --version` |
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
| `workers` | PostgreSQL + all Cloudflare Workers |
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

## Environment Variables

### Next.js backend

The Next.js service loads `env_file: .env` from the repo root. Make sure this file exists:

```bash
# If you have an .env.example, copy it
cp .env.example .env
# Then fill in the required values
```

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

## Architecture

- **Shared Docker image** (`dev/Dockerfile.dev`): `node:22-slim` with pnpm, wrangler, and bun pre-installed.
- **Volume mount**: The entire repo is mounted at `/app` — file changes are reflected immediately (hot reload works).
- **`network_mode: host`**: All services bind directly to the host network, so they can reach each other on `localhost` just like bare-metal dev.
- **Existing `dev/docker-compose.yml`** is untouched — it continues to work standalone for PostgreSQL-only usage.

## Troubleshooting

### Port already in use

If a service fails with `EADDRINUSE`, another process is already using that port. Check with:

```bash
lsof -i :<port>
# or
ss -tlnp | grep <port>
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
