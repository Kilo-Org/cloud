#!/usr/bin/env bash
#
# test-drain.sh — End-to-end graceful container eviction test.
#
# Usage:
#   ./scripts/test-drain.sh <townId> [port]
#
# Sends a task to the mayor, waits for a polecat to start working,
# triggers a graceful stop, and monitors the drain to completion.
# Prints a PASS/FAIL summary at the end.
#
# Requires: docker, curl, python3

set -euo pipefail

TOWN_ID="${1:?Usage: $0 <townId> [port]}"
PORT="${2:-8803}"
BASE="http://localhost:$PORT"
LOG_FILE="/tmp/drain-test-$(date +%s).log"

info()  { echo "[test-drain] $*"; }
fail()  { echo "[test-drain] FAIL: $*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────
info "Town: $TOWN_ID  Port: $PORT  Log: $LOG_FILE"

curl -sf "$BASE/health" > /dev/null || fail "Wrangler not running on port $PORT"

DRAIN=$(curl -sf "$BASE/debug/towns/$TOWN_ID/drain-status" | python3 -c "import sys,json; print(json.load(sys.stdin).get('draining', True))")
[ "$DRAIN" = "False" ] || fail "Town is still draining from a previous run. Wait for it to clear."

info "Preflight OK"

# ── Step 1: Send task ────────────────────────────────────────────────────
info "Sending task to mayor..."
curl -sf -m 120 -X POST "$BASE/debug/towns/$TOWN_ID/send-message" \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a bead for this task: Write src/drainTestUtils.ts with 8 utility functions including capitalize, slugify, truncate, camelCase, kebabCase, reverse, countWords, and isPalindrome. Each function needs JSDoc comments. Commit and push when done."}' > /dev/null

info "Task sent"

# ── Step 2: Wait for working polecat ─────────────────────────────────────
info "Waiting for a polecat to start working..."
POLECAT_READY=false
for i in $(seq 1 40); do
  WORKING=$(curl -sf "$BASE/debug/towns/$TOWN_ID/status" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for am in d.get('agentMeta', []):
    if am.get('role') == 'polecat' and am.get('status') == 'working':
        print(am.get('bead_id', '?')[:8])
" 2>/dev/null || true)
  if [ -n "$WORKING" ]; then
    info "Polecat working: $WORKING"
    POLECAT_READY=true
    break
  fi
  sleep 15
done
$POLECAT_READY || fail "No polecat started working within 10 minutes"

# ── Step 3: Find container and start log capture ─────────────────────────
CONTAINER_ID=$(docker ps --format "{{.ID}}\t{{.Image}}" | grep towncontainerdo | head -1 | awk '{print $1}')
[ -n "$CONTAINER_ID" ] || fail "No town container found"
info "Container: $CONTAINER_ID"

docker logs -f "$CONTAINER_ID" > "$LOG_FILE" 2>&1 &
LOG_PID=$!
trap "kill $LOG_PID 2>/dev/null" EXIT

# Wait 30s for the polecat to make progress
info "Waiting 30s for polecat progress..."
sleep 30

# ── Step 4: Trigger graceful stop ────────────────────────────────────────
info "=== TRIGGERING GRACEFUL STOP ==="
curl -sf -X POST "$BASE/debug/towns/$TOWN_ID/graceful-stop" > /dev/null
DRAIN_START=$(date +%s)

# ── Step 5: Monitor drain ────────────────────────────────────────────────
info "Monitoring drain..."
CONTAINER_EXITED=false
for i in $(seq 1 60); do
  sleep 10
  RUNNING=$(docker ps -q --filter "id=$CONTAINER_ID" 2>/dev/null)
  if [ -z "$RUNNING" ]; then
    DRAIN_END=$(date +%s)
    DRAIN_SECS=$((DRAIN_END - DRAIN_START))
    info "Container exited after ${DRAIN_SECS}s"
    CONTAINER_EXITED=true
    break
  fi
  DRAIN_LINE=$(grep "\[drain\]" "$LOG_FILE" 2>/dev/null | tail -1)
  echo "  $(date +%H:%M:%S) ${DRAIN_LINE:0:100}"
done

# ── Step 6: Verify ───────────────────────────────────────────────────────
echo ""
info "=== DRAIN LOG ==="
grep -E "\[drain\]|handleIdleEvent.*(idle timeout fired)|agent\.(exit|start)|Drain complete" "$LOG_FILE" 2>/dev/null || true

echo ""

if ! $CONTAINER_EXITED; then
  fail "Container did not exit within 10 minutes"
fi

# Check for drain completion
if grep -q "Drain complete" "$LOG_FILE" 2>/dev/null; then
  info "Drain completed successfully"
else
  fail "Drain did not complete (no 'Drain complete' in logs)"
fi

# Check Phase 1 succeeded
if grep -q "Phase 1: TownDO responded 200" "$LOG_FILE" 2>/dev/null; then
  info "Phase 1: TownDO notified OK"
else
  info "WARN: Phase 1 TownDO notification may have failed"
fi

# Check for force-save (Phase 3 stragglers)
STRAGGLERS=$(grep -c "Phase 3: force-saving" "$LOG_FILE" 2>/dev/null || echo "0")
MAYOR_ONLY=$(grep -c "Phase 3: froze agent.*mayor\|Phase 3: force-saving.*mayor" "$LOG_FILE" 2>/dev/null || echo "0")
NON_MAYOR_STRAGGLERS=$((STRAGGLERS - MAYOR_ONLY))
if [ "$NON_MAYOR_STRAGGLERS" -gt 0 ]; then
  info "WARN: $NON_MAYOR_STRAGGLERS non-mayor agent(s) were force-saved (did not exit cleanly)"
else
  info "All non-mayor agents exited cleanly (no force-save needed)"
fi

# Wait for drain flag to clear
info "Waiting for drain flag to clear..."
sleep 15
STILL_DRAINING=$(curl -sf "$BASE/debug/towns/$TOWN_ID/drain-status" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('draining', True))" 2>/dev/null || echo "unknown")
if [ "$STILL_DRAINING" = "False" ]; then
  info "Drain flag cleared"
elif [ "$STILL_DRAINING" = "unknown" ]; then
  info "WARN: Could not check drain status (wrangler may have restarted)"
else
  info "WARN: Drain flag still set (will clear on next heartbeat from new container)"
fi

echo ""
info "=== RESULT: PASS ==="
info "Drain completed in ${DRAIN_SECS:-?}s, container exited, log at $LOG_FILE"
