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

export PORT
export NEXTAUTH_URL="${NEXTAUTH_URL:-${APP_URL_OVERRIDE:-http://localhost:$PORT}}"
exec npx next dev -p "$PORT" "$@"
