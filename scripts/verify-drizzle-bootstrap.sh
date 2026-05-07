#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose -f dev/docker-compose.yml up -d --wait postgres >/dev/null

BASE_POSTGRES_URL="$({
  if [ -n "${POSTGRES_URL:-}" ]; then
    printf '%s' "$POSTGRES_URL"
  else
    node <<'NODE'
const fs = require('fs');

for (const path of ['.env.local', '.env']) {
  if (!fs.existsSync(path)) continue;

  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('POSTGRES_URL=')) continue;

    let value = line.slice('POSTGRES_URL='.length).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    process.stdout.write(value);
    process.exit(0);
  }
}

console.error('POSTGRES_URL is not set in the environment or .env.local');
process.exit(1);
NODE
  fi
})"

TEMP_DB="drizzle_bootstrap_$(date +%s)_${RANDOM}"
TEMP_POSTGRES_URL="$(node -e "const u = new URL(process.argv[1]); u.pathname = '/${TEMP_DB}'; process.stdout.write(u.toString());" "$BASE_POSTGRES_URL")"

cleanup() {
  docker compose -f dev/docker-compose.yml exec -T postgres \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"${TEMP_DB}\" WITH (FORCE);" >/dev/null
}
trap cleanup EXIT

docker compose -f dev/docker-compose.yml exec -T postgres \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"${TEMP_DB}\";" >/dev/null

POSTGRES_URL="$TEMP_POSTGRES_URL" pnpm drizzle migrate

echo "Verified pnpm drizzle migrate against empty database: ${TEMP_DB}"
