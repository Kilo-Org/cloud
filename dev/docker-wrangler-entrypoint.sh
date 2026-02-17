#!/usr/bin/env bash
# Entrypoint for wrangler-based services in Docker Compose.
#
# Problem: wrangler.jsonc files hardcode "localhost" for inter-service URLs
# (e.g., Hyperdrive localConnectionString, KILOCODE_BACKEND_BASE_URL). When
# running in Docker Compose with bridge networking, "localhost" inside a
# container refers to that container itself, not other services.
#
# Solution: This script creates a temporary copy of the worker's wrangler.jsonc,
# replaces "localhost" references with Docker Compose service names (which
# resolve via Docker's built-in DNS on the shared bridge network), then runs
# wrangler dev using the patched config.
#
# Usage (in docker-compose.dev.yml):
#   command: /app/dev/docker-wrangler-entrypoint.sh <worker-dir> [wrangler-dev-args...]
#
# Example:
#   command: /app/dev/docker-wrangler-entrypoint.sh cloud-agent --env dev --port 8788 --ip 0.0.0.0

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: docker-wrangler-entrypoint.sh <worker-dir> [wrangler-dev-args...]"
  echo "  e.g. docker-wrangler-entrypoint.sh cloud-agent --env dev --port 8788 --ip 0.0.0.0"
  exit 1
fi

WORKER_DIR="$1"
shift  # remaining args are passed to wrangler dev

WORKER_PATH="/app/${WORKER_DIR}"
ORIGINAL_CONFIG="${WORKER_PATH}/wrangler.jsonc"
PATCHED_CONFIG="/tmp/wrangler-docker.jsonc"

if [ ! -f "$ORIGINAL_CONFIG" ]; then
  echo "❌ wrangler.jsonc not found at ${ORIGINAL_CONFIG}"
  exit 1
fi

# Create a patched copy with Docker service names instead of localhost.
# These replacements map localhost ports to the corresponding Docker Compose
# service names (which resolve via DNS on the shared bridge network):
#
#   localhost:3000  → nextjs:3000          (Next.js backend)
#   localhost:5432  → postgres:5432        (PostgreSQL via Hyperdrive)
#   localhost:8787  → cloudflare-ai-attribution:8787
#   localhost:8788  → cloud-agent:8788
#   localhost:8793  → cloudflare-webhook-agent-ingest:8793
#   localhost:8794  → cloud-agent-next:8794
#   localhost:8800  → cloudflare-session-ingest:8800
sed \
  -e 's|localhost:3000|nextjs:3000|g' \
  -e 's|localhost:5432|postgres:5432|g' \
  -e 's|localhost:8787|cloudflare-ai-attribution:8787|g' \
  -e 's|localhost:8788|cloud-agent:8788|g' \
  -e 's|localhost:8793|cloudflare-webhook-agent-ingest:8793|g' \
  -e 's|localhost:8794|cloud-agent-next:8794|g' \
  -e 's|localhost:8800|cloudflare-session-ingest:8800|g' \
  "$ORIGINAL_CONFIG" > "$PATCHED_CONFIG"

cd "$WORKER_PATH"

# Run predev script if it exists (e.g., cloud-agent builds its wrapper via bun)
if node -e "const p=require('./package.json'); process.exit(p.scripts?.predev ? 0 : 1)" 2>/dev/null; then
  echo "▶ Running predev script for ${WORKER_DIR}..."
  pnpm run predev
fi

exec wrangler dev --config "$PATCHED_CONFIG" "$@"
