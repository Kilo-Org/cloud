#!/usr/bin/env bash
# Start the local KiloClaw development environment.
#
# Opens terminal windows: Next.js, KiloClaw worker, cloudflared tunnel, and Stripe webhook.
# Handles both named and temporary (quick) Cloudflare tunnels.
#
# Usage:
#   ./scripts/dev-start.sh [options]
#
# Options:
#   --has-controller-changes   Force a Docker image build+push even if no source
#                              changes are detected. Normally the script auto-
#                              detects changes by hashing the image source files
#                              against the last pushed hash (FLY_IMAGE_CONTENT_HASH
#                              in .dev.vars). After the push, you must restart/
#                              redeploy your instance from the dashboard.
#   --tunnel-name <name>       Use a named Cloudflare tunnel instead of a
#                              temporary quick tunnel. Named tunnels have a
#                              stable hostname that doesn't change between restarts.
#   --display <mode>           How to display the dev processes:
#                                tabs   — separate terminal tabs/windows (default)
#                                         macOS: iTerm2 or Terminal.app
#                                         Linux: gnome-terminal, konsole, xfce4-terminal,
#                                                mate-terminal, lxterminal, kitty, alacritty
#                                         Falls back to tmux if no supported terminal found.
#                                split  — single tab with split panes (requires iTerm2, macOS only)
#                                         On Linux, automatically falls back to tmux.
#                                tmux   — tmux session "kiloclaw" (2x2 pane grid, cross-platform)
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
MONOREPO_ROOT="$(cd "$KILOCLAW_DIR/../.." && pwd)"
APPS_WEB_DIR="$MONOREPO_ROOT/apps/web"

# ---------- OS detection ----------

OS_TYPE="$(uname -s)"

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
      echo "Display modes: tabs (default), split (macOS/iTerm2), tmux"
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

# On Linux, 'split' requires iTerm2 (macOS-only) — fall back to tmux.
# 'tabs' falls back to tmux if no supported Linux terminal emulator is found.
if [ "$OS_TYPE" = "Linux" ]; then
  if [ "$DISPLAY_MODE" = "split" ]; then
    echo "==> 'split' display mode requires iTerm2 (macOS). Falling back to 'tmux'."
    DISPLAY_MODE="tmux"
  elif [ "$DISPLAY_MODE" = "tabs" ]; then
    LINUX_TERM=""
    for t in gnome-terminal konsole xfce4-terminal mate-terminal lxterminal kitty alacritty; do
      if command -v "$t" &>/dev/null; then
        LINUX_TERM="$t"
        break
      fi
    done
    if [ -z "$LINUX_TERM" ]; then
      echo "==> No supported terminal emulator found for 'tabs' mode on Linux. Falling back to 'tmux'."
      DISPLAY_MODE="tmux"
    fi
  fi
fi

# ---------- Pre-flight checks ----------

# Verify required CLIs are available before doing any work
missing_cli=false
for cli in vercel pnpm docker cloudflared stripe; do
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
  if [ "$OS_TYPE" = "Darwin" ]; then
    echo "  cloudflared: brew install cloudflare/cloudflare/cloudflared"
    echo "  stripe:      brew install stripe/stripe-cli/stripe"
  else
    echo "  cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    echo "  stripe:      https://docs.stripe.com/stripe-cli#install"
  fi
  exit 1
fi

# Ensure Node.js matches the version in .nvmrc (auto-switch via nvm if needed).
# New terminal tabs/tmux panes don't inherit nvm state, so we also build a prefix
# (NVM_PREFIX) that spawned shell commands prepend to activate the correct version.
REQUIRED_NODE="$(tr -d '[:space:]' < "$MONOREPO_ROOT/.nvmrc" 2>/dev/null)"
REQUIRED_NODE="${REQUIRED_NODE:-22}"
REQUIRED_NODE_MAJOR="$(echo "$REQUIRED_NODE" | cut -d. -f1)"
CURRENT_NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"

NVM_PREFIX=""
if [ -n "${NVM_DIR:-}" ] && [ -s "$NVM_DIR/nvm.sh" ]; then
  if [ "${CURRENT_NODE_MAJOR:-0}" != "$REQUIRED_NODE_MAJOR" ]; then
    echo "==> Node.js $(node -v 2>/dev/null || echo 'not found') active; switching to v${REQUIRED_NODE} via nvm..."
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use "$REQUIRED_NODE"
  # Force nvm's bin dir first in PATH. In some environments (e.g. homebrew
  # pnpm at /opt/homebrew/bin/pnpm) `nvm use` alone doesn't reorder PATH
  # enough, so pnpm still resolves to a standalone install running under a
  # different node version.
  NVM_BIN="$(dirname "$(nvm which "$REQUIRED_NODE")")"
  export PATH="${NVM_BIN}:${PATH}"
  hash -r
  NVM_PREFIX=". '${NVM_DIR}/nvm.sh' && nvm use ${REQUIRED_NODE} && export PATH=\$(dirname \"\$(nvm which ${REQUIRED_NODE})\"):\$PATH && "
elif [ "${CURRENT_NODE_MAJOR:-0}" != "$REQUIRED_NODE_MAJOR" ]; then
  echo "ERROR: Node.js ${REQUIRED_NODE_MAJOR}.x required but $(node -v 2>/dev/null || echo 'none') is active."
  echo "Install nvm and Node.js ${REQUIRED_NODE}: nvm install ${REQUIRED_NODE} && nvm use ${REQUIRED_NODE}"
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
if ! (cd "$MONOREPO_ROOT" && vercel env pull --environment=development "$APPS_WEB_DIR/.env.local" && vercel env pull --environment=development); then
  echo ""
  echo "ERROR: 'vercel env pull' failed."
  echo "Check your Vercel authentication: vercel login"
  echo "Then retry this script."
  exit 1
fi

# Comment out POSTGRES_REPLICA_EU_URL unless --with-replica is passed.
# In local dev this connection string is unreachable and causes startup hangs.
if [ "$WITH_REPLICA" = false ]; then
  if grep -q '^POSTGRES_REPLICA_EU_URL=' "$APPS_WEB_DIR/.env.local"; then
    echo "==> Commenting out POSTGRES_REPLICA_EU_URL in .env.local (pass --with-replica to keep it)"
    sed 's/^POSTGRES_REPLICA_EU_URL=/# POSTGRES_REPLICA_EU_URL=/' \
      "$APPS_WEB_DIR/.env.local" > "$APPS_WEB_DIR/.env.local.tmp"
    mv "$APPS_WEB_DIR/.env.local.tmp" "$APPS_WEB_DIR/.env.local"
  fi
fi

# ---------- Sync shared secrets from .env.local into .dev.vars ----------

ENV_LOCAL="$APPS_WEB_DIR/.env.local"
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
  local token_rc=0
  NEW_TOKEN="$(fly tokens create org "$FLY_ORG" 2>&1)" || token_rc=$?
  if [ "$token_rc" -ne 0 ] || [ -z "$NEW_TOKEN" ]; then
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

# ---------- Resolve developer identity for machine tagging ----------

echo "==> Resolving developer identity..."
if ! command -v fly &>/dev/null; then
  echo ""
  echo "WARNING: 'fly' CLI not found — cannot determine developer identity."
  echo "  Dev Fly machines will not be tagged with your identity for cleanup."
  echo "  Install the Fly CLI: https://fly.io/docs/flyctl/install/"
  echo ""
  DEV_CREATOR=""
elif ! DEV_CREATOR="$(fly auth whoami 2>/dev/null)" || [ -z "$DEV_CREATOR" ]; then
  echo ""
  echo "WARNING: Could not determine your Fly identity."
  echo "  'fly auth whoami' failed — are you logged in?"
  echo "  Run 'fly auth login' to authenticate, then restart dev-start."
  echo ""
  echo "  Dev Fly machines will not be tagged with your identity."
  echo "  This means cleanup scripts won't be able to find your machines."
  echo ""
  DEV_CREATOR=""
else
  echo "    Developer identity: $DEV_CREATOR"
fi

if grep -q '^DEV_CREATOR=' "$KILOCLAW_DIR/.dev.vars"; then
  sed "s|^DEV_CREATOR=.*|DEV_CREATOR=$DEV_CREATOR|" \
    "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
  mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
else
  echo "DEV_CREATOR=$DEV_CREATOR" >> "$KILOCLAW_DIR/.dev.vars"
fi

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
if ! (cd "$MONOREPO_ROOT" && docker compose -f dev/docker-compose.yml up -d --wait); then
  echo ""
  echo "ERROR: 'docker compose up' failed."
  echo "Check 'docker compose -f dev/docker-compose.yml logs' for details."
  exit 1
fi

# Extra safety: wait for Postgres to accept connections (handles first-run init)
echo "==> Waiting for Postgres to accept connections..."
for i in $(seq 1 30); do
  if docker exec "$(docker compose -f "$MONOREPO_ROOT/dev/docker-compose.yml" ps -q postgres)" \
    pg_isready -U postgres -q 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: Postgres did not become ready within 30 seconds."
    echo "Check: docker compose -f dev/docker-compose.yml logs postgres"
    exit 1
  fi
  sleep 1
done
echo "    Postgres is ready."

echo "==> Running database migrations..."
if ! (cd "$MONOREPO_ROOT" && pnpm drizzle migrate); then
  echo ""
  echo "ERROR: Database migrations failed."
  echo "The database container may not be ready yet. Check:"
  echo "  docker compose -f dev/docker-compose.yml ps"
  echo "  docker compose -f dev/docker-compose.yml logs"
  exit 1
fi

# ---------- Detect controller image changes ----------

# Compute a content hash of all files baked into the Docker image (mirrors
# the CI hash in deploy-kiloclaw.yml).  Resolve the sha command once so
# xargs can invoke it (shell functions are invisible to xargs).
if command -v sha256sum &>/dev/null; then
  _SHA="sha256sum"
else
  _SHA="shasum -a 256"
fi

compute_image_hash() {
  (cd "$KILOCLAW_DIR" \
    && find Dockerfile controller/ container/ skills/ \
         openclaw-pairing-list.js openclaw-device-pairing-list.js \
         -type f 2>/dev/null \
    | sort \
    | xargs $_SHA \
    | $_SHA \
    | cut -d' ' -f1 \
    | cut -c1-12)
}

CURRENT_IMAGE_HASH="$(compute_image_hash)"
STORED_IMAGE_HASH="$(grep '^FLY_IMAGE_CONTENT_HASH=' "$KILOCLAW_DIR/.dev.vars" \
  | head -1 | sed 's/^[^=]*=//' | sed 's/^"//;s/"$//' || true)"

if [ "$CURRENT_IMAGE_HASH" != "$STORED_IMAGE_HASH" ]; then
  if [ "$HAS_CONTROLLER_CHANGES" = false ]; then
    echo "==> Controller source files changed since last image push."
    echo "    Current hash: $CURRENT_IMAGE_HASH"
    echo "    Last push:    ${STORED_IMAGE_HASH:-<none>}"
    echo "    Auto-enabling --has-controller-changes."
    HAS_CONTROLLER_CHANGES=true
  fi
else
  if [ "$HAS_CONTROLLER_CHANGES" = true ]; then
    echo "==> Controller source files unchanged (hash: $CURRENT_IMAGE_HASH)."
    echo "    --has-controller-changes was passed; forcing rebuild anyway."
  fi
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

  if [ "$OS_TYPE" = "Linux" ]; then
    # On Linux, open a new terminal window with the given command.
    # LINUX_TERM is resolved during display-mode validation above.
    case "${LINUX_TERM:-}" in
      gnome-terminal)
        gnome-terminal --title="$title" -- bash -c "echo '--- $title ---'; $cmd; exec bash" &
        ;;
      konsole)
        konsole --new-tab -p tabtitle="$title" -e bash -c "echo '--- $title ---'; $cmd; exec bash" &
        ;;
      xfce4-terminal)
        xfce4-terminal --title="$title" -e "bash -c \"echo '--- $title ---'; $cmd; exec bash\"" &
        ;;
      mate-terminal)
        mate-terminal --title="$title" -e "bash -c \"echo '--- $title ---'; $cmd; exec bash\"" &
        ;;
      lxterminal)
        lxterminal --title="$title" -e "bash -c \"echo '--- $title ---'; $cmd; exec bash\"" &
        ;;
      kitty)
        kitty --title "$title" bash -c "echo '--- $title ---'; $cmd; exec bash" &
        ;;
      alacritty)
        alacritty --title "$title" -e bash -c "echo '--- $title ---'; $cmd; exec bash" &
        ;;
      *)
        echo "ERROR: No supported terminal emulator for 'tabs' mode on Linux."
        echo "Supported: gnome-terminal, konsole, xfce4-terminal, mate-terminal, lxterminal, kitty, alacritty"
        echo "Use --display tmux instead."
        exit 1
        ;;
    esac
    return
  fi

  # macOS: use osascript for iTerm2 or Terminal.app
  # Escape backslashes and double quotes so $cmd is safe inside AppleScript strings
  local safe_cmd="${cmd//\\/\\\\}"
  safe_cmd="${safe_cmd//\"/\\\"}"

  if osascript -e 'tell application "System Events" to (name of processes) contains "iTerm2"' 2>/dev/null | grep -q true; then
    osascript <<EOF
tell application "iTerm"
  activate
  tell current window
    create tab with default profile
    tell current session
      set name to "$title"
      write text "echo '--- $title ---'; $safe_cmd"
    end tell
  end tell
end tell
EOF
  else
    osascript <<EOF
tell application "Terminal"
  activate
  do script "printf '\\\\e]0;$title\\\\a'; $safe_cmd"
end tell
EOF
  fi
}

# Open 3 commands in a single iTerm2 tab with vertical/horizontal splits (macOS only):
#   ┌──────────────┬──────────────┐
#   │   tunnel     │   Next.js    │
#   │              ├──────────────┤
#   │              │   worker     │
#   └──────────────┴──────────────┘
open_split_screen() {
  if [ "$OS_TYPE" = "Linux" ]; then
    echo "ERROR: split mode requires iTerm2 (macOS only). Use --display tmux on Linux."
    exit 1
  fi

  local title1="$1" cmd1="$2"
  local title2="$3" cmd2="$4"
  local title3="$5" cmd3="$6"

  # Escape backslashes and double quotes so commands are safe inside AppleScript strings
  local safe1="${cmd1//\\/\\\\}"; safe1="${safe1//\"/\\\"}"
  local safe2="${cmd2//\\/\\\\}"; safe2="${safe2//\"/\\\"}"
  local safe3="${cmd3//\\/\\\\}"; safe3="${safe3//\"/\\\"}"

  osascript <<EOF
tell application "iTerm"
  activate
  tell current window
    create tab with default profile

    -- Left pane: tunnel (named "KiloClaw Dev" so the tab title is readable)
    tell current session
      set name to "KiloClaw Dev"
      write text "echo '--- $title1 ---'; $safe1"

      -- Split right
      set rightSession to (split vertically with default profile)
    end tell

    -- Top-right pane: Next.js
    tell rightSession
      set name to "$title2"
      write text "echo '--- $title2 ---'; $safe2"

      -- Split bottom
      set bottomRightSession to (split horizontally with default profile)
    end tell

    -- Bottom-right pane: worker
    tell bottomRightSession
      set name to "$title3"
      write text "echo '--- $title3 ---'; $safe3"
    end tell
  end tell
end tell
EOF
}

# Split the existing tmux "kiloclaw" session window into panes (pairs of title, cmd).
# The session must already exist with one pane (stripe, created during startup).
# Produces a 2x2 grid:
#   ┌──────────────┬──────────────┐
#   │   stripe     │   tunnel     │
#   ├──────────────┼──────────────┤
#   │   nextjs     │   worker     │
#   └──────────────┴──────────────┘
add_tmux_panes() {
  local session="kiloclaw"

  # Pane 0 already has stripe running. Split right for tunnel.
  tmux split-window -t "$session" -h
  tmux send-keys -t "$session" "$1" C-m
  shift

  # Split pane 0 (stripe) downward for nextjs.
  tmux select-pane -t "$session.0"
  tmux split-window -t "$session" -v
  tmux send-keys -t "$session" "$1" C-m
  shift

  # Split pane 1 (tunnel, now index 1 after insert) downward for worker.
  tmux select-pane -t "$session.1"
  tmux split-window -t "$session" -v
  tmux send-keys -t "$session" "$1" C-m

  # Select top-left pane (stripe)
  tmux select-pane -t "$session.0"
}

# ---------- Helper: update KILOCODE_API_BASE_URL in .dev.vars ----------

set_api_base_url() {
  local url="$1"
  local quiet="${2:-}"
  if [ -z "$quiet" ]; then
    echo "    Setting KILOCODE_API_BASE_URL=$url"
  fi
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
    echo "ERROR: Could not capture tunnel URL after 30 seconds."
    echo "Clearing KILOCODE_API_BASE_URL in .dev.vars to prevent stale URL usage."
    echo ""
    echo "Check that cloudflared is authenticated (run 'cloudflared login') and can"
    echo "reach Cloudflare, then re-run this script."
    echo ""
    # Clear the URL so the worker fails loudly instead of using a stale URL
    set_api_base_url "" quiet
    # Kill the background tunnel process if it's still running
    if [ "$QUICK_TUNNEL_STARTED" = true ]; then
      kill "$TUNNEL_PID" 2>/dev/null || true
      wait "$TUNNEL_PID" 2>/dev/null || true
    else
      echo "NOTE: A cloudflared terminal tab may still be running — close it manually."
      echo ""
    fi
    rm -f "$TUNNEL_LOG"
    exit 1
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

# ---------- Start Stripe webhook and capture signing secret ----------
# Start stripe early (like the quick tunnel) so we can capture the webhook
# signing secret and write it to .env.development.local BEFORE Next.js starts.
# The process keeps running — it is NOT restarted later.

echo "==> Starting Stripe webhook listener..."
STRIPE_CMD="${NVM_PREFIX}cd '$MONOREPO_ROOT' && pnpm run stripe"
STRIPE_LOG="$(mktemp)"

if [ "$DISPLAY_MODE" = "tmux" ]; then
  # For tmux, create the session now with stripe as the first window
  if ! command -v tmux &>/dev/null; then
    if [ "$OS_TYPE" = "Darwin" ]; then
      echo "ERROR: 'tmux' not found. Install it: brew install tmux"
    else
      echo "ERROR: 'tmux' not found. Install it via your package manager (e.g. apt install tmux)"
    fi
    exit 1
  fi
  tmux kill-session -t kiloclaw 2>/dev/null || true
  tmux new-session -d -s kiloclaw -n stripe
  tmux send-keys -t kiloclaw:stripe "$STRIPE_CMD 2>&1 | tee $STRIPE_LOG" C-m
else
  # For tabs/split, open stripe in its own terminal tab
  open_terminal_tab "Stripe webhook" "$STRIPE_CMD 2>&1 | tee $STRIPE_LOG"
fi

echo "    Waiting for Stripe webhook signing secret..."
STRIPE_WHSEC=""
for i in $(seq 1 30); do
  STRIPE_WHSEC=$(grep -oE 'whsec_[a-zA-Z0-9]+' "$STRIPE_LOG" 2>/dev/null | head -1 || true)
  if [ -n "$STRIPE_WHSEC" ]; then
    break
  fi
  sleep 1
done

rm -f "$STRIPE_LOG"

if [ -z "$STRIPE_WHSEC" ]; then
  echo ""
  echo "WARNING: Could not capture Stripe webhook signing secret after 30 seconds."
  echo "You may need to run 'stripe login' first, or manually set"
  echo "STRIPE_WEBHOOK_SECRET in .env.development.local."
  echo ""
else
  echo "    Stripe webhook signing secret: $STRIPE_WHSEC"
  DEV_LOCAL="$MONOREPO_ROOT/.env.development.local"
  if [ -f "$DEV_LOCAL" ] && grep -q '^STRIPE_WEBHOOK_SECRET=' "$DEV_LOCAL"; then
    sed "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=\"$STRIPE_WHSEC\"|" \
      "$DEV_LOCAL" > "$DEV_LOCAL.tmp"
    mv "$DEV_LOCAL.tmp" "$DEV_LOCAL"
  else
    # Ensure the file exists and append the secret
    echo "" >> "$DEV_LOCAL"
    echo "# Stripe integration" >> "$DEV_LOCAL"
    echo "STRIPE_WEBHOOK_SECRET=\"$STRIPE_WHSEC\"" >> "$DEV_LOCAL"
  fi
  echo "    Saved STRIPE_WEBHOOK_SECRET to .env.development.local"
fi

# ---------- Launch processes ----------

NEXTJS_CMD="${NVM_PREFIX}cd '$MONOREPO_ROOT/apps/web' && pnpm dev"
WORKER_CMD="${NVM_PREFIX}sleep 2 && cd '$KILOCLAW_DIR' && pnpm run dev"

case "$DISPLAY_MODE" in
  tmux)
    # Stripe is already running in pane 0 of the tmux session "kiloclaw".
    # Split into a 2x2 grid for all 4 processes.
    echo "==> Splitting tmux session 'kiloclaw' into 4 panes..."

    add_tmux_panes \
      "$TUNNEL_CMD" \
      "$NEXTJS_CMD" \
      "$WORKER_CMD"

    echo ""
    echo "Dev environment running in tmux session 'kiloclaw' (4 panes)."
    echo "  Attaching..."
    exec tmux attach -t kiloclaw
    ;;

  split)
    echo "==> Opening split-screen tab in iTerm2..."

    # Stripe tab already running (started above).
    if [ -n "$TUNNEL_NAME" ]; then
      # Named tunnel: tunnel + Next.js + worker in one split tab
      open_split_screen \
        "cloudflared tunnel" "$TUNNEL_CMD" \
        "Next.js" "$NEXTJS_CMD" \
        "KiloClaw worker" "$WORKER_CMD"
    else
      # Quick tunnel already running in its own tab; put Next.js + worker in splits
      safe_nextjs="${NEXTJS_CMD//\\/\\\\}"; safe_nextjs="${safe_nextjs//\"/\\\"}"
      safe_worker="${WORKER_CMD//\\/\\\\}"; safe_worker="${safe_worker//\"/\\\"}"
      osascript <<EOF
tell application "iTerm"
  activate
  tell current window
    create tab with default profile

    tell current session
      set name to "Next.js"
      write text "echo '--- Next.js ---'; $safe_nextjs"
      set workerSession to (split horizontally with default profile)
    end tell

    tell workerSession
      set name to "KiloClaw worker"
      write text "echo '--- KiloClaw worker ---'; $safe_worker"
    end tell
  end tell
end tell
EOF
    fi

    echo ""
    echo "Dev environment starting in split-screen iTerm2 tab."
    ;;

  tabs)
    # Separate tabs (Stripe tab already opened above)
    if [ -n "$TUNNEL_NAME" ]; then
      open_terminal_tab "cloudflared tunnel" "$TUNNEL_CMD"
    fi
    # Quick tunnel tab was already opened above

    echo "==> Starting Next.js (pnpm dev)..."
    open_terminal_tab "Next.js" "$NEXTJS_CMD"

    echo "==> Starting KiloClaw worker (pnpm run dev)..."
    open_terminal_tab "KiloClaw worker" "$WORKER_CMD"

    echo ""
    if [ "$OS_TYPE" = "Linux" ]; then
      echo "Dev environment starting in 4 terminal windows:"
    else
      echo "Dev environment starting in 4 terminal tabs:"
    fi
    echo "  1. Stripe webhook listener"
    echo "  2. cloudflared tunnel"
    echo "  3. Next.js (port 3000)"
    echo "  4. KiloClaw worker (port 8795)"
    ;;
esac

echo ""
echo "Open http://localhost:3000 to use the dashboard."
