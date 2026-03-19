#!/bin/bash
# Start the local KiloClaw development environment.
#
# Opens three terminal windows: Next.js, KiloClaw worker, and cloudflared tunnel.
# Handles both named and temporary (quick) Cloudflare tunnels.
#
# Usage:
#   ./scripts/dev-start.sh [options]
#
# Options:
#   --has-controller-changes   Build and push a new Docker image before starting.
#                              After the push, you must restart/redeploy your
#                              instance from the dashboard.
#   --tunnel-name <name>       Use a named Cloudflare tunnel instead of a
#                              temporary quick tunnel. Named tunnels have a
#                              stable hostname that doesn't change between restarts.
#   --display <mode>           How to display the 3 dev processes:
#                                tabs   — separate terminal tabs (default)
#                                split  — single tab with split panes (requires iTerm2)
#                                tmux   — tmux session "kiloclaw"
#   --with-replica             Keep POSTGRES_REPLICA_EU_URL in .env.local.
#                              By default it is commented out (unreachable locally).
#
# Config (highest priority wins):
#   1. CLI flags
#   2. Project-local:  kiloclaw/scripts/.dev-start.conf (gitignored, per-worktree overrides)
#   3. User-global:    ~/.config/kiloclaw/dev-start.conf (shared across worktrees)
#   4. Built-in defaults
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
MONOREPO_ROOT="$(cd "$KILOCLAW_DIR/.." && pwd)"

# ---------- Defaults (overridden by .dev-start.conf, then by CLI flags) ----------

HAS_CONTROLLER_CHANGES=false
TUNNEL_NAME=""
TUNNEL_HOSTNAME=""
DISPLAY_MODE="tabs"
WITH_REPLICA=false

# Source user config: project-local overrides user-global
if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/kiloclaw/dev-start.conf" ]; then
  # shellcheck source=/dev/null
  source "${XDG_CONFIG_HOME:-$HOME/.config}/kiloclaw/dev-start.conf"
fi
if [ -f "$SCRIPT_DIR/.dev-start.conf" ]; then
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/.dev-start.conf"
fi

# CLI flags override config
while [[ $# -gt 0 ]]; do
  case "$1" in
    --has-controller-changes)
      HAS_CONTROLLER_CHANGES=true
      shift
      ;;
    --tunnel-name)
      TUNNEL_NAME="$2"
      shift 2
      ;;
    --display)
      DISPLAY_MODE="$2"
      shift 2
      ;;
    --with-replica)
      WITH_REPLICA=true
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: $0 [--has-controller-changes] [--tunnel-name <name>] [--display <mode>] [--with-replica]"
      echo "Display modes: tabs (default), split, tmux"
      exit 1
      ;;
  esac
done

# Validate DISPLAY_MODE
case "$DISPLAY_MODE" in
  tabs|split|tmux) ;;
  *)
    echo "ERROR: Unknown display mode '$DISPLAY_MODE'."
    echo "Valid modes: tabs, split, tmux"
    exit 1
    ;;
esac

# ---------- Pre-flight checks ----------

# Verify required CLIs are available before doing any work
missing_cli=false
for cli in vercel pnpm docker cloudflared; do
  if ! command -v "$cli" &>/dev/null; then
    echo "ERROR: '$cli' CLI not found."
    missing_cli=true
  fi
done
if [ "$missing_cli" = true ]; then
  echo ""
  echo "Install missing tools before running this script."
  echo "  vercel:      npm i -g vercel"
  echo "  pnpm:        corepack enable && corepack prepare pnpm@latest --activate"
  echo "  docker:      https://docs.docker.com/get-docker/"
  echo "  cloudflared: brew install cloudflare/cloudflare/cloudflared"
  exit 1
fi

if [ ! -f "$KILOCLAW_DIR/.dev.vars" ]; then
  echo "==> Creating .dev.vars from .dev.vars.example..."
  cp "$KILOCLAW_DIR/.dev.vars.example" "$KILOCLAW_DIR/.dev.vars"
fi

# ---------- Link & pull dev environment from Vercel ----------

if [ ! -d "$MONOREPO_ROOT/.vercel" ] || [ ! -f "$MONOREPO_ROOT/.vercel/project.json" ]; then
  echo "==> Vercel project not linked. Linking to kilocode-app..."
  if ! (cd "$MONOREPO_ROOT" && vercel link --project=kilocode-app --scope=kilocode --yes); then
    echo ""
    echo "ERROR: 'vercel link' failed."
    echo "You may need to log in first: vercel login"
    exit 1
  fi
fi

echo "==> Pulling development environment from Vercel..."
if ! (cd "$MONOREPO_ROOT" && vercel env pull --environment=development); then
  echo ""
  echo "ERROR: 'vercel env pull' failed."
  echo "Check your Vercel authentication: vercel login"
  echo "Then retry this script."
  exit 1
fi

# Comment out POSTGRES_REPLICA_EU_URL unless --with-replica is passed.
# In local dev this connection string is unreachable and causes startup hangs.
if [ "$WITH_REPLICA" = false ]; then
  if grep -q '^POSTGRES_REPLICA_EU_URL=' "$MONOREPO_ROOT/.env.local"; then
    echo "==> Commenting out POSTGRES_REPLICA_EU_URL in .env.local (pass --with-replica to keep it)"
    sed 's/^POSTGRES_REPLICA_EU_URL=/# POSTGRES_REPLICA_EU_URL=/' \
      "$MONOREPO_ROOT/.env.local" > "$MONOREPO_ROOT/.env.local.tmp"
    mv "$MONOREPO_ROOT/.env.local.tmp" "$MONOREPO_ROOT/.env.local"
  fi
fi

# ---------- Sync shared secrets from .env.local into .dev.vars ----------

ENV_LOCAL="$MONOREPO_ROOT/.env.local"
if [ ! -f "$ENV_LOCAL" ]; then
  echo ""
  echo "ERROR: .env.local not found after 'vercel env pull'."
  echo "This usually means the Vercel project has no development environment variables."
  echo "Check the kilocode-app project at https://vercel.com and ensure development"
  echo "environment variables are configured."
  exit 1
fi

echo "==> Syncing secrets from .env.local into .dev.vars..."

# Extract a value from .env.local, stripping surrounding quotes
env_local_val() {
  grep "^$1=" "$ENV_LOCAL" | head -1 | sed 's/^[^=]*=//' | sed 's/^"//;s/"$//' || true
}

SYNC_WARNINGS=0

# NEXTAUTH_SECRET → NEXTAUTH_SECRET
NEXTAUTH_SECRET_VAL="$(env_local_val NEXTAUTH_SECRET)"
if [ -n "$NEXTAUTH_SECRET_VAL" ]; then
  sed "s|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET=$NEXTAUTH_SECRET_VAL|" \
    "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
  mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
else
  echo "    WARNING: NEXTAUTH_SECRET not found in .env.local — JWT auth will fail"
  SYNC_WARNINGS=$((SYNC_WARNINGS + 1))
fi

# KILOCLAW_INTERNAL_API_SECRET → INTERNAL_API_SECRET
INTERNAL_SECRET_VAL="$(env_local_val KILOCLAW_INTERNAL_API_SECRET)"
if [ -n "$INTERNAL_SECRET_VAL" ]; then
  sed "s|^INTERNAL_API_SECRET=.*|INTERNAL_API_SECRET=$INTERNAL_SECRET_VAL|" \
    "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
  mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
else
  echo "    WARNING: KILOCLAW_INTERNAL_API_SECRET not found in .env.local — platform API auth will fail"
  SYNC_WARNINGS=$((SYNC_WARNINGS + 1))
fi

if [ "$SYNC_WARNINGS" -gt 0 ]; then
  echo ""
  echo "    $SYNC_WARNINGS secret(s) missing from .env.local."
  echo "    The worker will start but auth will not work correctly."
  echo "    Check that development environment variables are set in Vercel."
  echo ""
fi

# ---------- Sync config secrets into .dev.vars ----------

# Sync AGENT_ENV_VARS_PRIVATE_KEY from config into .dev.vars.
# The value is a multiline PEM key, so sed can't handle it — strip existing
# lines (including continuation lines of a quoted multiline value) then append.
if [ -n "${AGENT_ENV_VARS_PRIVATE_KEY:-}" ]; then
  echo "==> Syncing AGENT_ENV_VARS_PRIVATE_KEY from config into .dev.vars..."
  # Remove existing AGENT_ENV_VARS_PRIVATE_KEY block (single or multiline quoted value)
  awk '
    /^AGENT_ENV_VARS_PRIVATE_KEY=/ {
      # If the line has an opening quote without a closing quote, skip until end-quote
      if ($0 ~ /="/ && $0 !~ /"$/) { skip=1 }
      next
    }
    skip && /"$/ { skip=0; next }
    skip { next }
    { print }
  ' "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
  mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
  # Append the key (printf to preserve embedded newlines)
  printf 'AGENT_ENV_VARS_PRIVATE_KEY="%s"\n' "$AGENT_ENV_VARS_PRIVATE_KEY" >> "$KILOCLAW_DIR/.dev.vars"
fi

# Check AGENT_ENV_VARS_PRIVATE_KEY is configured (first line only for validation)
AGENT_KEY="$(grep '^AGENT_ENV_VARS_PRIVATE_KEY=' "$KILOCLAW_DIR/.dev.vars" | head -1 | sed 's/^[^=]*=//' | sed 's/^"//;s/"$//' || true)"
if [ -z "$AGENT_KEY" ] || [ "$AGENT_KEY" = "..." ]; then
  echo "ERROR: AGENT_ENV_VARS_PRIVATE_KEY is not configured in .dev.vars."
  echo "Set it in your config file or in .dev.vars directly."
  echo "  Config: ${XDG_CONFIG_HOME:-$HOME/.config}/kiloclaw/dev-start.conf"
  echo "  Direct: $KILOCLAW_DIR/.dev.vars"
  echo "Get the dev version from 1Password (engineering vault)."
  exit 1
fi

# ---------- Validate / refresh Fly API token ----------

# Read FLY_ORG_SLUG from .dev.vars (defaults to kilo-dev in .dev.vars.example)
FLY_ORG="$(grep '^FLY_ORG_SLUG=' "$KILOCLAW_DIR/.dev.vars" | head -1 | sed 's/^[^=]*=//' | sed 's/^"//;s/"$//' || true)"
if [ -z "$FLY_ORG" ]; then
  FLY_ORG="kilo-dev"
fi

refresh_fly_token() {
  echo "==> Generating new Fly API token for org '$FLY_ORG'..."
  if ! command -v fly &>/dev/null; then
    echo "ERROR: 'fly' CLI not found. Install it: https://fly.io/docs/flyctl/install/"
    exit 1
  fi
  NEW_TOKEN="$(fly tokens create org "$FLY_ORG" 2>&1)"
  if [ $? -ne 0 ] || [ -z "$NEW_TOKEN" ]; then
    echo "ERROR: Failed to create Fly token. Are you logged in? Try 'fly auth login'."
    echo "$NEW_TOKEN"
    exit 1
  fi
  sed "s|^FLY_API_TOKEN=.*|FLY_API_TOKEN=$NEW_TOKEN|" \
    "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
  mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
  FLY_TOKEN="$NEW_TOKEN"
  echo "    Token saved to .dev.vars."
}

FLY_TOKEN="$(grep '^FLY_API_TOKEN=' "$KILOCLAW_DIR/.dev.vars" | head -1 | sed 's/^[^=]*=//' | sed 's/^"//;s/"$//' || true)"

if [ -z "$FLY_TOKEN" ] || [ "$FLY_TOKEN" = "fo1_..." ]; then
  refresh_fly_token
fi

echo "==> Validating Fly API token..."
FLY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $FLY_TOKEN" \
  "https://api.machines.dev/v1/apps?org_slug=$FLY_ORG&limit=1")

if [ "$FLY_STATUS" != "200" ]; then
  echo "    Token is invalid or expired (HTTP $FLY_STATUS). Refreshing..."
  refresh_fly_token

  FLY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $FLY_TOKEN" \
    "https://api.machines.dev/v1/apps?org_slug=$FLY_ORG&limit=1")

  if [ "$FLY_STATUS" != "200" ]; then
    echo "ERROR: New token still failing (HTTP $FLY_STATUS). Check 'fly auth login' and org access."
    exit 1
  fi
fi

echo "    Fly API token is valid."

# ---------- Install dependencies ----------

echo "==> Installing dependencies..."
if ! (cd "$MONOREPO_ROOT" && pnpm install); then
  echo ""
  echo "ERROR: 'pnpm install' failed."
  echo "Try deleting node_modules and pnpm-lock.yaml, then retry."
  exit 1
fi

# ---------- Start database and run migrations ----------

echo "==> Starting local database..."
if ! docker info &>/dev/null; then
  echo ""
  echo "ERROR: Docker daemon is not running."
  echo "Start Docker Desktop (or 'dockerd') and retry."
  exit 1
fi
if ! (cd "$MONOREPO_ROOT" && docker compose -f dev/docker-compose.yml up -d); then
  echo ""
  echo "ERROR: 'docker compose up' failed."
  echo "Check 'docker compose -f dev/docker-compose.yml logs' for details."
  exit 1
fi

echo "==> Running database migrations..."
if ! (cd "$MONOREPO_ROOT" && pnpm drizzle migrate); then
  echo ""
  echo "ERROR: Database migrations failed."
  echo "The database container may not be ready yet. Check:"
  echo "  docker compose -f dev/docker-compose.yml ps"
  echo "  docker compose -f dev/docker-compose.yml logs"
  exit 1
fi

# ---------- Controller image push (optional) ----------

if [ "$HAS_CONTROLLER_CHANGES" = true ]; then
  echo "==> Building and pushing controller image..."
  echo ""
  "$KILOCLAW_DIR/scripts/push-dev.sh"
  echo ""
  echo "============================================================"
  echo "  IMAGE PUSHED — ACTION REQUIRED"
  echo "============================================================"
  echo ""
  echo "  Your KiloClaw instance is still running the old image."
  echo "  To pick up the new controller:"
  echo ""
  echo "  1. Open the dashboard at http://localhost:3000"
  echo "  2. Go to your instance's Settings tab"
  echo "  3. Click 'Destroy', then re-provision a new instance"
  echo ""
  echo "  (A simple restart is enough if only controller routes"
  echo "   changed. Destroy + re-provision is needed if the volume"
  echo "   or Fly app config changed.)"
  echo ""
  echo "============================================================"
  echo ""
fi

# ---------- Helpers: open commands in terminal ----------

open_terminal_tab() {
  local title="$1"
  local cmd="$2"

  if osascript -e 'tell application "System Events" to (name of processes) contains "iTerm2"' 2>/dev/null | grep -q true; then
    osascript <<EOF
tell application "iTerm"
  activate
  tell current window
    create tab with default profile
    tell current session
      set name to "$title"
      write text "echo '--- $title ---'; $cmd"
    end tell
  end tell
end tell
EOF
  else
    osascript <<EOF
tell application "Terminal"
  activate
  do script "printf '\\e]0;$title\\a'; $cmd"
end tell
EOF
  fi
}

# Open 3 commands in a single iTerm2 tab with vertical/horizontal splits:
#   ┌──────────────┬──────────────┐
#   │   tunnel     │   Next.js    │
#   │              ├──────────────┤
#   │              │   worker     │
#   └──────────────┴──────────────┘
open_split_screen() {
  local title1="$1" cmd1="$2"
  local title2="$3" cmd2="$4"
  local title3="$5" cmd3="$6"

  osascript <<EOF
tell application "iTerm"
  activate
  tell current window
    create tab with default profile

    -- Left pane: tunnel (named "KiloClaw Dev" so the tab title is readable)
    tell current session
      set name to "KiloClaw Dev"
      write text "echo '--- $title1 ---'; $cmd1"

      -- Split right
      set rightSession to (split vertically with default profile)
    end tell

    -- Top-right pane: Next.js
    tell rightSession
      set name to "$title2"
      write text "echo '--- $title2 ---'; $cmd2"

      -- Split bottom
      set bottomRightSession to (split horizontally with default profile)
    end tell

    -- Bottom-right pane: worker
    tell bottomRightSession
      set name to "$title3"
      write text "echo '--- $title3 ---'; $cmd3"
    end tell
  end tell
end tell
EOF
}

# Open 3 commands in a tmux session called "kiloclaw" with 3 windows:
open_tmux_session() {
  local title1="$1" cmd1="$2"
  local title2="$3" cmd2="$4"
  local title3="$5" cmd3="$6"

  local session="kiloclaw"

  # Kill existing session if present
  tmux kill-session -t "$session" 2>/dev/null || true

  tmux new-session -d -s "$session" -n "$title1"
  tmux send-keys -t "$session:$title1" "$cmd1" C-m

  tmux new-window -t "$session" -n "$title2"
  tmux send-keys -t "$session:$title2" "$cmd2" C-m

  tmux new-window -t "$session" -n "$title3"
  tmux send-keys -t "$session:$title3" "$cmd3" C-m

  # Select the first window
  tmux select-window -t "$session:$title1"
}

# ---------- Helper: update KILOCODE_API_BASE_URL in .dev.vars ----------

set_api_base_url() {
  local url="$1"
  echo "    Setting KILOCODE_API_BASE_URL=$url"
  if grep -q '^KILOCODE_API_BASE_URL=' "$KILOCLAW_DIR/.dev.vars"; then
    sed "s|^KILOCODE_API_BASE_URL=.*|KILOCODE_API_BASE_URL=$url|" \
      "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
    mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
  elif grep -q '^# KILOCODE_API_BASE_URL=' "$KILOCLAW_DIR/.dev.vars"; then
    sed "s|^# KILOCODE_API_BASE_URL=.*|KILOCODE_API_BASE_URL=$url|" \
      "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
    mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
  else
    echo "KILOCODE_API_BASE_URL=$url" >> "$KILOCLAW_DIR/.dev.vars"
  fi
}

# ---------- Prepare tunnel command and update .dev.vars ----------

if [ -n "$TUNNEL_NAME" ]; then
  echo "==> Using named tunnel: $TUNNEL_NAME"
  TUNNEL_CMD="cloudflared tunnel run $TUNNEL_NAME"

  if [ -n "$TUNNEL_HOSTNAME" ]; then
    set_api_base_url "https://${TUNNEL_HOSTNAME}/api/gateway/"
  fi
else
  # Temporary quick tunnel — start it early to capture the URL.
  echo "==> Starting temporary cloudflared tunnel..."
  echo "    (Capturing tunnel URL to update .dev.vars)"

  TUNNEL_CMD="cloudflared tunnel --url http://localhost:3000"
  TUNNEL_LOG="$(mktemp)"
  QUICK_TUNNEL_STARTED=false

  if [ "$DISPLAY_MODE" = "tmux" ]; then
    # For tmux, start the tunnel in the background to capture the URL
    $TUNNEL_CMD > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    QUICK_TUNNEL_STARTED=true
  else
    open_terminal_tab "cloudflared tunnel" "$TUNNEL_CMD 2>&1 | tee $TUNNEL_LOG"
  fi

  echo "    Waiting for tunnel URL..."
  TUNNEL_URL=""
  for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
    if [ -n "$TUNNEL_URL" ]; then
      break
    fi
    sleep 1
  done

  if [ -z "$TUNNEL_URL" ]; then
    echo ""
    echo "WARNING: Could not capture tunnel URL after 30 seconds."
    echo "Check the cloudflared terminal tab and manually update"
    echo "KILOCODE_API_BASE_URL in .dev.vars, then restart the worker."
    echo ""
  else
    echo "    Tunnel URL: $TUNNEL_URL"
    set_api_base_url "${TUNNEL_URL}/api/gateway/"
  fi

  # For tmux, kill the background tunnel — it will be restarted inside tmux
  if [ "$QUICK_TUNNEL_STARTED" = true ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
  fi

  rm -f "$TUNNEL_LOG"
fi

# ---------- Launch processes ----------

NEXTJS_CMD="cd '$MONOREPO_ROOT' && pnpm dev"
WORKER_CMD="sleep 2 && cd '$KILOCLAW_DIR' && pnpm run dev"

case "$DISPLAY_MODE" in
  tmux)
    echo "==> Starting tmux session 'kiloclaw'..."

    if ! command -v tmux &>/dev/null; then
      echo "ERROR: 'tmux' not found. Install it: brew install tmux"
      exit 1
    fi

    open_tmux_session \
      "tunnel" "$TUNNEL_CMD" \
      "nextjs" "$NEXTJS_CMD" \
      "worker" "$WORKER_CMD"

    echo ""
    echo "Dev environment running in tmux session 'kiloclaw'."
    echo "  Attach with: tmux attach -t kiloclaw"
    ;;

  split)
    echo "==> Opening split-screen tab in iTerm2..."

    if [ -n "$TUNNEL_NAME" ]; then
      # Named tunnel: all 3 in one split tab
      open_split_screen \
        "cloudflared tunnel" "$TUNNEL_CMD" \
        "Next.js" "$NEXTJS_CMD" \
        "KiloClaw worker" "$WORKER_CMD"
    else
      # Quick tunnel already running in its own tab; put Next.js + worker in splits
      osascript <<EOF
tell application "iTerm"
  activate
  tell current window
    create tab with default profile

    tell current session
      set name to "Next.js"
      write text "echo '--- Next.js ---'; $NEXTJS_CMD"
      set workerSession to (split horizontally with default profile)
    end tell

    tell workerSession
      set name to "KiloClaw worker"
      write text "echo '--- KiloClaw worker ---'; $WORKER_CMD"
    end tell
  end tell
end tell
EOF
    fi

    echo ""
    echo "Dev environment starting in split-screen iTerm2 tab."
    ;;

  tabs)
    # Separate tabs
    if [ -n "$TUNNEL_NAME" ]; then
      open_terminal_tab "cloudflared tunnel" "$TUNNEL_CMD"
    fi
    # Quick tunnel tab was already opened above

    echo "==> Starting Next.js (pnpm dev)..."
    open_terminal_tab "Next.js" "$NEXTJS_CMD"

    echo "==> Starting KiloClaw worker (pnpm run dev)..."
    open_terminal_tab "KiloClaw worker" "$WORKER_CMD"

    echo ""
    echo "Dev environment starting in 3 terminal tabs:"
    echo "  1. cloudflared tunnel"
    echo "  2. Next.js (port 3000)"
    echo "  3. KiloClaw worker (port 8795)"
    ;;
esac

echo ""
echo "Open http://localhost:3000 to use the dashboard."
