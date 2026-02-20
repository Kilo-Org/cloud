#!/usr/bin/env bash
# Start the Docker Compose dev environment for the monorepo.
#
# Usage:
#   ./dev/dev.sh                                    # start everything
#   ./dev/dev.sh --profile core                     # postgres + nextjs
#   ./dev/dev.sh --profile core --profile agents    # core + cloud-agent services
#   ./dev/dev.sh --profile workers                  # postgres + all CF workers
#   ./dev/dev.sh up postgres nextjs cloud-agent     # specific services only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/dev/docker-compose.dev.yml"

# ── Preflight checks ─────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  echo "❌ Docker is not installed. Please install Docker first."
  echo "   https://docs.docker.com/get-docker/"
  exit 1
fi

if ! docker compose version &>/dev/null; then
  echo "❌ Docker Compose v2 is required (docker compose, not docker-compose)."
  echo "   https://docs.docker.com/compose/install/"
  exit 1
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  if ! command -v pnpm &>/dev/null; then
    echo "❌ pnpm is not installed and node_modules is missing."
    echo "   Install pnpm first: corepack enable && corepack prepare pnpm@10.27.0 --activate"
    echo "   Then run: pnpm install"
    exit 1
  fi
  echo "⚠️  node_modules not found. Running pnpm install first..."
  (cd "$REPO_ROOT" && pnpm install)
fi

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "⚠️  No .env file found at repo root."
  echo "   Copy .env.example or create one before the Next.js service can start."
fi

# ── Launch ────────────────────────────────────────────────────────────

# If no arguments provided, start everything with the "all" profile
if [ $# -eq 0 ]; then
  echo "🚀 Starting all services..."
  exec docker compose -f "$COMPOSE_FILE" --profile all up
else
  echo "🚀 Starting services..."
  exec docker compose -f "$COMPOSE_FILE" "$@"
fi
