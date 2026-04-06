#!/usr/bin/env bash
set -uo pipefail

# ──────────────────────────────────────────────────────────────
# dev-auto-fix.sh — Start all dev services in parallel with colored logs
# ──────────────────────────────────────────────────────────────
#
# Services:
#   1. Root (Next.js)           — port 3000
#   2. Session Worker           — port 8800  (inspector 9230)
#   3. Auto Fix Worker          — port 8792  (inspector 9231)
#   4. Agent Next Worker        — port 8794  (inspector 9232)
#
# Log files are written to dev/.dev-logs/auto-fix/<service>.log (ANSI stripped)
# so AI agents and other tools can read them easily.
#
# Usage:
#   ./dev/auto-fix/dev-auto-fix.sh            # start all services
#   ./dev/auto-fix/dev-auto-fix.sh --no-root  # skip the Next.js root app
# ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUD_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="$CLOUD_DIR/dev/.dev-logs/auto-fix"

# ANSI colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# Strip ANSI escape codes for clean log files
strip_ansi() {
  sed 's/\x1b\[[0-9;]*[a-zA-Z]//g'
}

# Prefixed log helper — adds colored service name to every line
# Also tees a clean (no ANSI) copy to the per-service log file
prefix_log() {
  local color="$1"
  local label="$2"
  local logfile="$LOG_DIR/${label}.log"
  while IFS= read -r line; do
    printf "${color}[%-14s]${RESET} %s\n" "$label" "$line"
    printf '%s\n' "$line" | strip_ansi >> "$logfile"
  done
}

# Kill the entire process group on exit (all children, pipes, subshells)
cleanup() {
  printf "\n${BOLD}${RED}Shutting down all services...${RESET}\n"
  trap - INT TERM EXIT  # prevent re-entry
  kill 0 2>/dev/null    # send TERM to every process in this process group
}
trap cleanup INT TERM EXIT

# Start a service in the background with prefixed output
start_service() {
  local dir="$1"
  local label="$2"
  local color="$3"
  shift 3
  local cmd=("$@")

  printf "${color}${BOLD}Starting %-14s${RESET} → %s\n" "$label" "$dir"
  (cd "$dir" && exec "${cmd[@]}") 2>&1 | prefix_log "$color" "$label" &
}

# Like start_service but takes a shell string (for compound commands)
start_service_sh() {
  local dir="$1"
  local label="$2"
  local color="$3"
  local cmd="$4"

  printf "${color}${BOLD}Starting %-14s${RESET} → %s\n" "$label" "$dir"
  (cd "$dir" && eval "$cmd") 2>&1 | prefix_log "$color" "$label" &
}

# ── Parse flags ──────────────────────────────────────────────
SKIP_ROOT=false
for arg in "$@"; do
  case "$arg" in
    --no-root) SKIP_ROOT=true ;;
  esac
done

# ── Prepare log directory ────────────────────────────────────
rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

# ── Banner ───────────────────────────────────────────────────
printf "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║      Kilo Cloud Auto Fix Services        ║"
echo "╚══════════════════════════════════════════╝"
printf "${RESET}\n"
printf "${CYAN}Logs → %s/${RESET}\n\n" "$LOG_DIR"

# ── Launch services ──────────────────────────────────────────
# Each wrangler worker gets a unique --inspector-port to avoid all three
# fighting over the default 9229.

if [ "$SKIP_ROOT" = false ]; then
  start_service "$CLOUD_DIR/apps/web" "root" "$GREEN" \
    pnpm run dev
fi

start_service "$CLOUD_DIR/services/session-ingest" "session" "$YELLOW" \
  pnpm exec wrangler dev --inspector-port 9230

start_service "$CLOUD_DIR/services/auto-fix-infra" "auto-fix" "$BLUE" \
  pnpm exec wrangler dev --inspector-port 9231

# agent-next needs its predev (build:wrapper) step before starting wrangler
start_service_sh "$CLOUD_DIR/services/cloud-agent-next" "agent-next" "$RED" \
  "pnpm run build:wrapper && exec pnpm exec wrangler dev --env dev --inspector-port 9232"

printf "\n${BOLD}${CYAN}All services launched. Press Ctrl+C to stop.${RESET}\n\n"

# Wait for all background processes
wait
