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
ADMIN_POSTGRES_URL="$(node -e "const u = new URL(process.argv[1]); u.pathname = '/postgres'; process.stdout.write(u.toString());" "$BASE_POSTGRES_URL")"

admin_db() {
  ACTION="$1" TEMP_DB="$TEMP_DB" ADMIN_POSTGRES_URL="$ADMIN_POSTGRES_URL" \
    pnpm --filter @kilocode/db exec node <<'NODE'
const { Client } = require('pg');

const action = process.env.ACTION;
const database = process.env.TEMP_DB;
const connectionString = process.env.ADMIN_POSTGRES_URL;

if (!/^[A-Za-z0-9_]+$/.test(database || '')) {
  throw new Error(`Unsafe temporary database name: ${database}`);
}

async function main() {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (action === 'create') {
      await client.query(`CREATE DATABASE "${database}";`);
    } else if (action === 'drop') {
      await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE);`);
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
NODE
}

cleanup() {
  admin_db drop >/dev/null || true
}
trap cleanup EXIT

admin_db create >/dev/null

POSTGRES_URL="$TEMP_POSTGRES_URL" pnpm drizzle migrate

echo "Verified pnpm drizzle migrate against empty database: ${TEMP_DB}"
