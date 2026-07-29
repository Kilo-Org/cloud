#!/usr/bin/env bash
# Orchestrator helper: run a local kilo CLI against this worktree's local backend
# stack, as a "remote CLI session" the mobile app can discover and mirror.
#
# It resolves the running stack's ports from `pnpm dev:status --json`, mints a
# bearer token for a user via `pnpm dev:seed app:api-token`, installs the kilo
# CLI in a disposable per-worktree directory, and exposes it two ways:
#   - an interactive TUI in a `kilo-e2e-cli-<worktree-slug>` tmux session, and
#   - a passthrough for any one-off `kilo` command (remote, run, session, ...).
#
# Usage:
#   apps/mobile/e2e/remote-cli.sh start <email> [--reinstall]   # interactive TUI in tmux
#   apps/mobile/e2e/remote-cli.sh prepare <email> [--reinstall] # write env only, no launch
#   apps/mobile/e2e/remote-cli.sh exec <kilo args...>           # run any kilo command
#   apps/mobile/e2e/remote-cli.sh status
#   apps/mobile/e2e/remote-cli.sh stop [--purge]
#
# Examples:
#   apps/mobile/e2e/remote-cli.sh exec remote          # enable remote relay
#   apps/mobile/e2e/remote-cli.sh exec session list --pure
#   apps/mobile/e2e/remote-cli.sh exec run "say hello"
#
# The email is required and must be the account the app is signed in as —
# e2e/login.sh's default is e2e-mobile-<worktree-slug>-<ios|android>@example.com.
# The user must already exist (sign in on the device first, or seed one).
# `exec` reuses an already-prepared env; run `start <email>` once first.
#
# Env overrides:
#   KILO_CLI_VERSION   npm version/tag of @kilocode/cli to install (default: latest)
#   KILO_CLI_BIN       absolute path to a locally built kilo binary; skips npm install,
#                      prepends its directory to PATH, and emits KILO_NO_DAEMON=1,
#                      KILO_DEBUG_SESSION_INGEST=true, and KILO_REMOTE=1 into the env file
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

# Populated by prepare_env for callers that print a summary.
PREP_EMAIL="" PREP_USER_ID="" PREP_NEXTJS="" PREP_INGEST="" PREP_EVENT=""

port_from_status() {
  # $1 = status json, $2 = service name. Prints port or empty when not "up".
  node - "$1" "$2" <<'NODE'
const [statusJson, name] = process.argv.slice(2);
const status = JSON.parse(statusJson);
const service = status.services.find(s => s.name === name);
if (service && service.status === 'up' && service.port) process.stdout.write(String(service.port));
NODE
}

# Resolve ports, mint a token, install the CLI, and write ENV_FILE. All progress
# goes to stderr so `exec` keeps command stdout clean.
prepare_env() {
  local email="$1" reinstall="$2"

  echo "==> reading worktree stack status" >&2
  local status nextjs_port ingest_port event_port
  status="$(cd "$REPO_ROOT" && pnpm -s dev:status --json)"
  nextjs_port="$(port_from_status "$status" nextjs)"
  ingest_port="$(port_from_status "$status" cloudflare-session-ingest)"
  event_port="$(port_from_status "$status" event-service)"

  if [ -z "$nextjs_port" ] || [ -z "$ingest_port" ]; then
    echo "Required services are not up for $REPO_ROOT." >&2
    echo "If you hold no E2E slot: take one, then .kilo_workflow/e2e-start-resource.sh stack mobile cloud-agent-next kiloclaw event-service" >&2
    echo "If a bundle owner already runs this stack, use it — never start a second one." >&2
    exit 1
  fi
  if [ -z "$event_port" ]; then
    echo "   warning: event-service is not up; CLI presence in the app needs it (start the event-service group)." >&2
  fi

  echo "==> minting bearer token for $email" >&2
  local token_json token user_id
  if ! token_json="$(cd "$REPO_ROOT" && pnpm -s dev:seed app:api-token "$email" --json)"; then
    echo "Failed to mint a token for $email. Sign in on the device first, or seed a user." >&2
    exit 1
  fi
  token="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).token)' "$token_json")"
  user_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userId)' "$token_json")"

  echo "==> preparing kilo CLI in $CLI_HOME" >&2
  mkdir -p "$CLI_HOME"
  local cli_path_prefix="${CLI_HOME}/node_modules/.bin"
  local local_cli_exports=""
  if [ -n "${KILO_CLI_BIN:-}" ]; then
    if [ ! -x "$KILO_CLI_BIN" ] || [ ! -f "$KILO_CLI_BIN" ]; then
      echo "KILO_CLI_BIN is set but is not an executable file: $KILO_CLI_BIN" >&2
      exit 1
    fi
    cli_path_prefix="$(cd "$(dirname "$KILO_CLI_BIN")" && pwd)"
    echo "   using local CLI binary: $KILO_CLI_BIN (skipped npm install)" >&2
    local_cli_exports=$(cat <<'LOCAL_EOF'
export KILO_NO_DAEMON="1"
export KILO_DEBUG_SESSION_INGEST="true"
export KILO_REMOTE="1"
LOCAL_EOF
)
  elif [ "$reinstall" = "1" ] || [ ! -x "$CLI_HOME/node_modules/.bin/kilo" ]; then
    [ -f "$CLI_HOME/package.json" ] || (cd "$CLI_HOME" && npm init -y >/dev/null 2>&1)
    echo "   installing @kilocode/cli@${KILO_CLI_VERSION:-latest} (this can take a moment)" >&2
    (cd "$CLI_HOME" && npm install "@kilocode/cli@${KILO_CLI_VERSION:-latest}" >"$CLI_HOME/install.log" 2>&1) \
      || { echo "CLI install failed; see $CLI_HOME/install.log" >&2; tail -n 20 "$CLI_HOME/install.log" >&2; exit 1; }
  fi

  # Isolate the CLI's XDG data/config dirs from the machine's global kilo
  # install. The CLI stores its OAuth login in $XDG_DATA_HOME/kilo/auth.json
  # (default ~/.local/share/kilo); if a developer is logged in there, the CLI
  # uses that production credential for AI-gateway calls and ignores the minted
  # KILO_API_KEY below, so the local gateway rejects it ("You need to sign in to
  # use this model" / "not a member of the organization"). Pointing both XDG
  # dirs into the disposable per-worktree home forces the CLI to fall back to
  # the minted local token against this worktree's stack.
  local xdg_data="${CLI_HOME}/xdg/data" xdg_config="${CLI_HOME}/xdg/config"
  mkdir -p "$xdg_data" "$xdg_config"

  # Env file carries the token; keep it private and out of the process table.
  # KILO_AUTH_CONTENT is JSON.parse'd by the CLI into its process-local
  # credential map (provider id -> credential); a bare token fails to parse and
  # the CLI silently drops it ("invalid KILO_AUTH_CONTENT; using no
  # process-local credentials"), then falls back to the production account. The
  # gateway provider id is "kilo" and an API-key credential is {type:"api",key}.
  umask 077
  cat >"$ENV_FILE" <<EOF
export KILO_API_URL="http://localhost:${nextjs_port}"
export KILO_API_KEY="${token}"
export KILO_AUTH_CONTENT='{"kilo":{"type":"api","key":"${token}"}}'
export KILO_SESSION_INGEST_URL="http://localhost:${ingest_port}"
$([ -n "$event_port" ] && echo "export KILO_EVENT_SERVICE_URL=\"ws://localhost:${event_port}\"")
export KILO_CONFIG_DIR="${CLI_HOME}/.config"
export XDG_DATA_HOME="${xdg_data}"
export XDG_CONFIG_HOME="${xdg_config}"
export KILO_DISABLE_AUTOUPDATE="true"
export PATH="${cli_path_prefix}:\$PATH"
EOF
  if [ -n "$local_cli_exports" ]; then
    printf '%s\n' "$local_cli_exports" >>"$ENV_FILE"
  fi

  PREP_EMAIL="$email" PREP_USER_ID="$user_id"
  PREP_NEXTJS="$nextjs_port" PREP_INGEST="$ingest_port" PREP_EVENT="$event_port"
}

# Parse "<email> [--reinstall]" for start/prepare. Sets OPT_EMAIL, OPT_REINSTALL.
parse_prepare_args() {
  OPT_EMAIL="" OPT_REINSTALL=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --reinstall) OPT_REINSTALL=1 ;;
      --*) echo "Unknown option: $arg" >&2; exit 2 ;;
      *) if [ -z "$OPT_EMAIL" ]; then OPT_EMAIL="$arg"; else echo "Unexpected argument: $arg" >&2; exit 2; fi ;;
    esac
  done
  [ -n "$OPT_EMAIL" ] || { echo "usage: remote-cli.sh start|prepare <email> [--reinstall] — pass the account the app is signed in as" >&2; exit 2; }
}

cmd_prepare() {
  parse_prepare_args "$@"
  prepare_env "$OPT_EMAIL" "$OPT_REINSTALL"
  echo "Prepared local CLI env for $PREP_EMAIL ($PREP_USER_ID)."
  echo "Run a command: apps/mobile/e2e/remote-cli.sh exec <kilo args...>"
  echo "Or the TUI    : apps/mobile/e2e/remote-cli.sh start"
}

cmd_start() {
  parse_prepare_args "$@"
  prepare_env "$OPT_EMAIL" "$OPT_REINSTALL"

  echo "==> launching CLI in tmux session '$SESSION'"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  tmux new-session -d -s "$SESSION" -c "$CLI_HOME" -x 220 -y 50
  tmux send-keys -t "$SESSION" "source '$ENV_FILE' && clear && kilo" Enter

  cat <<EOF

Remote CLI ready.
  tmux session : $SESSION
  user         : $PREP_EMAIL ($PREP_USER_ID)
  worktree     : $REPO_ROOT
  API          : http://localhost:${PREP_NEXTJS}
  session-ingest: http://localhost:${PREP_INGEST}${PREP_EVENT:+
  event-service: ws://localhost:${PREP_EVENT}}

Attach : tmux attach -t $SESSION
Inspect: tmux capture-pane -p -t $SESSION -S -100
Command: apps/mobile/e2e/remote-cli.sh exec <kilo args...>
Stop   : apps/mobile/e2e/remote-cli.sh stop

Type a prompt in the CLI to create a session; it appears in the mobile app's
Agents list within ~12s of the first heartbeat.
EOF
}

cmd_exec() {
  if [ "$#" -eq 0 ]; then
    echo "usage: remote-cli.sh exec <kilo args...>   (e.g. exec remote, exec session list --pure)" >&2
    echo "For the interactive TUI use: remote-cli.sh start" >&2
    exit 2
  fi
  if [ ! -f "$ENV_FILE" ]; then
    echo "no prepared env for this worktree — run: remote-cli.sh start <email> (the account the app is signed in as)" >&2
    exit 1
  fi
  # Run kilo with the prepared env in a subshell so it does not leak into the
  # caller. Command stdout/stderr and exit code pass straight through.
  ( set -a; . "$ENV_FILE"; set +a; exec kilo "$@" )
}

cmd_status() {
  if tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "Remote CLI session '$SESSION' is running."
    tmux capture-pane -p -t "$SESSION" -S -40 | sed -e 's/[[:space:]]*$//' | grep -v '^$' | tail -20
  else
    echo "No remote CLI session '$SESSION' is running."
    [ -f "$ENV_FILE" ] && echo "(env is prepared; run 'remote-cli.sh exec <args>' or 'start')" || true
  fi
}

cmd_stop() {
  local purge=0 arg
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
  prepare) shift || true; cmd_prepare "$@" ;;
  exec) shift || true; cmd_exec "$@" ;;
  status) shift || true; [ "$#" -eq 0 ] || { echo "status takes no arguments" >&2; exit 2; }; cmd_status ;;
  stop) shift || true; cmd_stop "$@" ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed '1d' ;;
  *) echo "unknown command: ${1} (expected start|prepare|exec|status|stop)" >&2; exit 2 ;;
esac
