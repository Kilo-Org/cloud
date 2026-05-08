#!/usr/bin/env bash
set -euo pipefail

OFFSET=${KILO_PORT_OFFSET:-0}
TARGET_PORT=${PORT:-$((3000 + OFFSET))}

# Find an available port starting from TARGET_PORT (same behavior as Next.js auto-increment).
# Tries TARGET_PORT through TARGET_PORT+9, then falls back to port 0 (OS-assigned).
# Uses Node.js stdlib only — no external dependencies.
PORT=$(node -e "
  const net = require('net');
  function tryPort(port, retries) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(retries > 0 ? tryPort(port + 1, retries - 1) : tryPort(0, 0));
        } else {
          reject(err);
        }
      });
      server.once('listening', () => {
        const assignedPort = server.address().port;
        server.close(() => resolve(assignedPort));
      });
      server.listen(port);
    });
  }
  tryPort(${TARGET_PORT}, 10).then(p => console.log(p));
")

REPO_ROOT="$(git rev-parse --show-toplevel)"
echo "$PORT" > "$REPO_ROOT/.dev-port"
echo "Dev server starting on port $PORT (written to $REPO_ROOT/.dev-port)"

# Next.js loads .env* files from CWD. When running from apps/web/, symlink
# the repo-root env files so env vars are available without duplication.
for envfile in .env.local .env.development.local; do
  if [ -f "$REPO_ROOT/$envfile" ] && [ ! -f "$envfile" ]; then
    ln -s "$REPO_ROOT/$envfile" "$envfile"
    echo "Symlinked $REPO_ROOT/$envfile → $(pwd)/$envfile"
  fi
done

read_env_value() {
  local key="$1"
  local file
  local value

  for file in .env.development.local .env.local "$REPO_ROOT/.env.development.local" "$REPO_ROOT/.env.local"; do
    if [ -f "$file" ]; then
      value=$(awk -F= -v key="$key" '
        $1 == key {
          value = substr($0, length(key) + 2)
          gsub(/^["'\'']|["'\'']$/, "", value)
          print value
          exit
        }
      ' "$file")
      if [ -n "$value" ]; then
        echo "$value"
        return
      fi
    fi
  done
}

export PORT
APP_URL_OVERRIDE="${APP_URL_OVERRIDE:-$(read_env_value APP_URL_OVERRIDE)}"
NEXTAUTH_URL="${NEXTAUTH_URL:-$(read_env_value NEXTAUTH_URL)}"
NEXT_DEV_HOSTNAME="${NEXT_DEV_HOSTNAME:-0.0.0.0}"
# Only export APP_URL_OVERRIDE when set; an empty export becomes "" in
# process.env and defeats the `??` fallback in apps/web/src/lib/constants.ts.
if [ -n "$APP_URL_OVERRIDE" ]; then
  export APP_URL_OVERRIDE
fi
export NEXT_DEV_HOSTNAME
export NEXTAUTH_URL="${NEXTAUTH_URL:-${APP_URL_OVERRIDE:-http://localhost:$PORT}}"
exec next dev -H "$NEXT_DEV_HOSTNAME" -p "$PORT" "$@"
