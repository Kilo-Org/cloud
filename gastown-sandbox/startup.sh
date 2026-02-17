#!/bin/bash
# Startup script for Gastown Sandbox on Fly.io Machines
#
# This script:
# 1. Sets environment from provisioned secrets
# 2. Restores from R2 if backup exists and volume is empty (PR 4)
# 3. Runs `gt up` to start the gastown daemon
# 4. Starts R2 sync daemon in background (PR 4)
# 5. Starts internal API server in background (PR 3)
# 6. Starts terminal proxy in background (PR 7)
# 7. Handles SIGTERM for graceful shutdown
# 8. Keeps container alive

set -uo pipefail

GT_HOME="${GT_HOME:-/home/gt}"
DATA_DIR="${GT_HOME}/data"
LOG_DIR="${GT_HOME}/logs"

mkdir -p "$DATA_DIR" "$LOG_DIR"

# ============================================================
# LOGGING
# ============================================================
log() {
    echo "[gastown-sandbox] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

log "Starting gastown sandbox..."
log "GT_HOME=$GT_HOME"
log "DATA_DIR=$DATA_DIR"

# ============================================================
# ENVIRONMENT
# ============================================================
# Required env vars are set by the provisioning system:
#   KILO_API_URL  — gateway URL for LLM calls
#   KILO_JWT      — per-user gateway auth token
#   TOWN_ID       — unique town identifier
#   INTERNAL_API_KEY — shared secret for internal API auth
#
# Optional (added by later PRs):
#   R2_BUCKET, R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT

if [ -z "${KILO_API_URL:-}" ]; then
    log "WARNING: KILO_API_URL not set. LLM calls will fail."
fi

if [ -z "${TOWN_ID:-}" ]; then
    log "WARNING: TOWN_ID not set."
fi

# Export for gt and kilo-cli
export KILO_API_URL="${KILO_API_URL:-}"
export KILO_JWT="${KILO_JWT:-}"

# ============================================================
# CHILD PID TRACKING
# ============================================================
CHILD_PIDS=()

# ============================================================
# SIGTERM HANDLER
# ============================================================
shutdown() {
    log "Received shutdown signal, starting graceful shutdown..."

    # Trigger final R2 backup if sync daemon is available
    if [ -x /usr/local/bin/r2-sync-daemon.sh ]; then
        log "Flushing to R2 before shutdown..."
        /usr/local/bin/r2-sync-daemon.sh --flush 2>&1 | while read -r line; do log "r2-flush: $line"; done || true
    fi

    # Stop gt daemon
    log "Stopping gt daemon..."
    /usr/local/bin/gt down 2>&1 | while read -r line; do log "gt-down: $line"; done || true

    # Terminate background processes
    for pid in "${CHILD_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            log "Terminating PID $pid..."
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    # Wait briefly for children to exit
    for pid in "${CHILD_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            timeout 5 tail --pid="$pid" -f /dev/null 2>/dev/null || true
        fi
    done

    log "Shutdown complete."
    exit 0
}

trap shutdown SIGTERM SIGINT

# ============================================================
# R2 RESTORE (PR 4 — optional, resilient to absence)
# ============================================================
if [ -x /usr/local/bin/r2-restore.sh ]; then
    log "Checking if R2 restore is needed..."
    /usr/local/bin/r2-restore.sh 2>&1 | while read -r line; do log "r2-restore: $line"; done || {
        log "WARNING: R2 restore failed (non-fatal, continuing with empty volume)"
    }
else
    log "r2-restore.sh not found, skipping R2 restore"
fi

# ============================================================
# START GT DAEMON
# ============================================================
log "Starting gt daemon..."
if /usr/local/bin/gt up 2>&1 | while read -r line; do log "gt-up: $line"; done; then
    log "gt daemon started"
else
    log "ERROR: gt up failed. Continuing so sandbox remains reachable for debugging."
fi

# ============================================================
# R2 SYNC DAEMON (PR 4 — optional, resilient to absence)
# ============================================================
if [ -x /usr/local/bin/r2-sync-daemon.sh ]; then
    log "Starting R2 sync daemon..."
    /usr/local/bin/r2-sync-daemon.sh >> "$LOG_DIR/r2-sync.log" 2>&1 &
    CHILD_PIDS+=($!)
    log "R2 sync daemon started (PID $!)"
else
    log "r2-sync-daemon.sh not found, skipping R2 sync"
fi

# ============================================================
# INTERNAL API SERVER (PR 3 — optional, resilient to absence)
# ============================================================
if [ -x /usr/local/bin/internal-api ]; then
    log "Starting internal API server..."
    /usr/local/bin/internal-api >> "$LOG_DIR/internal-api.log" 2>&1 &
    CHILD_PIDS+=($!)
    log "Internal API server started (PID $!)"
elif [ -f /usr/local/lib/internal-api/server.js ]; then
    log "Starting internal API server (Node.js)..."
    node /usr/local/lib/internal-api/server.js >> "$LOG_DIR/internal-api.log" 2>&1 &
    CHILD_PIDS+=($!)
    log "Internal API server started (PID $!)"
else
    log "Internal API server not found, skipping"
fi

# ============================================================
# TERMINAL PROXY (PR 7 — optional, resilient to absence)
# ============================================================
if [ -x /usr/local/bin/terminal-proxy ]; then
    log "Starting terminal proxy..."
    /usr/local/bin/terminal-proxy >> "$LOG_DIR/terminal-proxy.log" 2>&1 &
    CHILD_PIDS+=($!)
    log "Terminal proxy started (PID $!)"
else
    log "terminal-proxy not found, skipping"
fi

# ============================================================
# KEEP ALIVE
# ============================================================
log "Sandbox ready. Waiting for shutdown signal..."

# Use wait instead of sleep infinity so we can respond to signals
while true; do
    sleep 60 &
    SLEEP_PID=$!
    wait $SLEEP_PID 2>/dev/null || true
done
