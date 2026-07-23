#!/usr/bin/env bash
# Orchestrator helper: run a local kilo CLI as a "remote CLI session" for this
# worktree, targeting this worktree's local backend stack.
#
# It resolves the running stack's ports from `pnpm dev:status --json`, mints a
# bearer token for a user via `pnpm dev:seed app:api-token`, installs the kilo
# CLI in a disposable per-worktree directory, and launches it in a
# `kilo-e2e-cli-<worktree-slug>` tmux session with the local API/session-ingest/
# event-service URLs and token already exported. The mobile app (signed in as
# the same user, pointed at the same worktree stack) then discovers and mirrors
# the CLI session.
#
# Usage:
#   apps/mobile/e2e/remote-cli.sh [start] [email] [--reinstall]
#   apps/mobile/e2e/remote-cli.sh status
#   apps/mobile/e2e/remote-cli.sh stop [--purge]
#
# When no email is given, defaults to the per-worktree-unique login account
# (e2e-mobile+<worktree-slug>@example.com), matching e2e/login.sh. The user must
# already exist (sign in on the device first, or seed one). Pass an explicit
# email to target a specific account (e.g. the one the app is signed in as).
#
# Env overrides:
#   KILO_CLI_VERSION   npm version/tag of @kilocode/cli to install (default: latest)
#
# Requires: node, tmux, npm, a running stack (see e2e/AGENTS.md). Never reads
# .env files directly; the token is minted by the dev:seed command.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
WORKTREE_SLUG="$(basename "$REPO_ROOT" | tr -cs 'a-zA-Z0-9' '-' | sed 's/^-*//;s/-*$//')"
SESSION="kilo-e2e-cli-${WORKTREE_SLUG}"
CLI_HOME="$REPO_ROOT/dev/.dev-logs/remote-cli/${WORKTREE_SLUG}"
ENV_FILE="$CLI_HOME/.cli-env"

port_from_status() {
  # $1 = status json, $2 = service name. Prints port or empty when not "up".
  node - "$1" "$2" <<'NODE'
const [statusJson, name] = process.argv.slice(2);
const status = JSON.parse(statusJson);
const service = status.services.find(s => s.name === name);
if (service && service.status === 'up' && service.port) process.stdout.write(String(service.port));
NODE
}

cmd_start() {
  local email="" reinstall=0 arg
  for arg in "$@"; do
    case "$arg" in
      --reinstall) reinstall=1 ;;
      --*) echo "Unknown option: $arg" >&2; exit 2 ;;
      *) if [ -z "$email" ]; then email="$arg"; else echo "Unexpected argument: $arg" >&2; exit 2; fi ;;
    esac
  done
  [ -n "$email" ] || email="e2e-mobile+${WORKTREE_SLUG}@example.com"

  echo "==> reading worktree stack status"
  local status nextjs_port ingest_port event_port
  status="$(cd "$REPO_ROOT" && pnpm -s dev:status --json)"
  nextjs_port="$(port_from_status "$status" nextjs)"
  ingest_port="$(port_from_status "$status" cloudflare-session-ingest)"
  event_port="$(port_from_status "$status" event-service)"

  if [ -z "$nextjs_port" ] || [ -z "$ingest_port" ]; then
    echo "Required services are not up for $REPO_ROOT." >&2
    echo "Start them first, e.g.: pnpm dev:start --no-attach mobile cloud-agent-next event-service" >&2
    exit 1
  fi
  if [ -z "$event_port" ]; then
    echo "   warning: event-service is not up; CLI presence in the app needs it (start the event-service group)." >&2
  fi

  echo "==> minting bearer token for $email"
  local token_json token user_id
  if ! token_json="$(cd "$REPO_ROOT" && pnpm -s dev:seed app:api-token "$email" --json)"; then
    echo "Failed to mint a token for $email. Sign in on the device first, or seed a user." >&2
    exit 1
  fi
  token="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$token_json")"
  user_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userId)' "$token_json")"

  echo "==> preparing kilo CLI in $CLI_HOME"
  mkdir -p "$CLI_HOME"
  if [ "$reinstall" = "1" ] || [ ! -x "$CLI_HOME/node_modules/.bin/kilo" ]; then
    [ -f "$CLI_HOME/package.json" ] || (cd "$CLI_HOME" && npm init -y >/dev/null 2>&1)
    echo "   installing @kilocode/cli@${KILO_CLI_VERSION:-latest} (this can take a moment)"
    (cd "$CLI_HOME" && npm install "@kilocode/cli@${KILO_CLI_VERSION:-latest}" >"$CLI_HOME/install.log" 2>&1) \
      || { echo "CLI install failed; see $CLI_HOME/install.log" >&2; tail -n 20 "$CLI_HOME/install.log" >&2; exit 1; }
  fi

  # Env file carries the token; keep it private and out of the process table.
  umask 077
  cat >"$ENV_FILE" <<EOF
export KILO_API_URL="http://localhost:${nextjs_port}"
export KILO_API_KEY="${token}"
export KILO_AUTH_CONTENT="${token}"
export KILO_SESSION_INGEST_URL="http://localhost:${ingest_port}"
$([ -n "$event_port" ] && echo "export KILO_EVENT_SERVICE_URL=\"ws://localhost:${event_port}\"")
export KILO_CONFIG_DIR="${CLI_HOME}/.config"
export KILO_DISABLE_AUTOUPDATE="true"
export PATH="${CLI_HOME}/node_modules/.bin:\$PATH"
EOF

  echo "==> launching CLI in tmux session '$SESSION'"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" -c "$CLI_HOME" -x 220 -y 50
  tmux send-keys -t "$SESSION" "source '$ENV_FILE' && clear && kilo" Enter

  cat <<EOF

Remote CLI ready.
  tmux session : $SESSION
  user         : $email ($user_id)
  worktree     : $REPO_ROOT
  API          : http://localhost:${nextjs_port}
  session-ingest: http://localhost:${ingest_port}${event_port:+
  event-service: ws://localhost:${event_port}}

Attach : tmux attach -t $SESSION
Inspect: tmux capture-pane -p -t $SESSION -S -100
Stop   : apps/mobile/e2e/remote-cli.sh stop

Type a prompt in the CLI to create a session; it appears in the mobile app's
Agents list within ~12s of the first heartbeat.
EOF
}

cmd_status() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Remote CLI session '$SESSION' is running."
    tmux capture-pane -p -t "$SESSION" -S -40 | sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -20
  else
    echo "No remote CLI session '$SESSION' is running."
  fi
}

cmd_stop() {
  local purge=0
  for arg in "$@"; do
    case "$arg" in
      --purge) purge=1 ;;
      *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
  done
  tmux kill-session -t "$SESSION" 2>/dev/null && echo "Stopped '$SESSION'." || echo "No session '$SESSION' to stop."
  rm -f "$ENV_FILE"
  if [ "$purge" = "1" ]; then
    rm -rf "$CLI_HOME"
    echo "Purged $CLI_HOME."
  fi
}

case "${1:-start}" in
  start) shift || true; cmd_start "$@" ;;
  status) shift || true; cmd_status ;;
  stop) shift || true; cmd_stop "$@" ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d' ;;
  *) cmd_start "$@" ;;
esac
