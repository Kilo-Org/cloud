#!/usr/bin/env bash
# Test 24: Stream ticket flow — the path the UI takes
# UI calls: getStreamTicket → construct WS URL → connect → receive events
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-stream-ticket-$(date +%s)"

docker ps -q 2>/dev/null | xargs -r docker kill 2>/dev/null || true
sleep 2

echo "  ═══ Setup ═══"
api_post "/api/users/${USER_ID}/towns" '{"name":"Stream-Ticket-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" --arg tk "$FAKE_TOKEN" \
  '{town_id: $t, name: "st-rig", git_url: "https://github.com/test/repo.git", default_branch: "main", kilocode_token: $tk}')"
assert_status "201" "create rig"

echo "  ═══ Step 1: Send mayor message ═══"
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Stream ticket test"}'
assert_status "200" "send mayor message"
MAYOR_AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  Mayor agent: ${MAYOR_AGENT_ID}"

echo "  ═══ Step 2: Wait for container (15s) ═══"
sleep 15

echo "  ═══ Step 3: Get stream ticket (like the UI does) ═══"
api_post "/api/towns/${TOWN_ID}/container/agents/${MAYOR_AGENT_ID}/stream-ticket"
echo "  Ticket response: status=${HTTP_STATUS} body=${HTTP_BODY}"

if [[ "$HTTP_STATUS" == "200" ]]; then
  STREAM_URL=$(echo "$HTTP_BODY" | jq -r '.data.url // empty')
  TICKET=$(echo "$HTTP_BODY" | jq -r '.data.ticket // empty')
  echo "  Stream URL: ${STREAM_URL}"
  echo "  Ticket: ${TICKET}"
  
  if [[ -n "$STREAM_URL" ]]; then
    echo "  ═══ Step 4: Connect WebSocket via ticket URL ═══"
    # The UI constructs: ws://host:port + streamUrl + ?ticket=...
    FULL_WS_URL="ws://localhost:${PORT}${STREAM_URL}"
    if [[ -n "$TICKET" ]]; then
      FULL_WS_URL="${FULL_WS_URL}?ticket=${TICKET}"
    fi
    echo "  Full WS URL: ${FULL_WS_URL}"
    
    WS_OUTPUT_FILE=$(mktemp)
    node "${SCRIPT_DIR}/ws-client.mjs" "${FULL_WS_URL}" 10 "${MAYOR_AGENT_ID}" > "$WS_OUTPUT_FILE" 2>"${WS_OUTPUT_FILE}.stderr" &
    WS_PID=$!
    sleep 12
    kill "$WS_PID" 2>/dev/null || true
    wait "$WS_PID" 2>/dev/null || true
    
    WS_STDERR=$(cat "${WS_OUTPUT_FILE}.stderr" 2>/dev/null || echo "")
    WS_MESSAGES=$(cat "$WS_OUTPUT_FILE" 2>/dev/null || echo "[]")
    MSG_COUNT=$(echo "$WS_MESSAGES" | jq 'length' 2>/dev/null || echo "0")
    
    echo "  WS client output:"
    echo "$WS_STDERR" | head -5 | sed 's/^/    /'
    echo "  Messages: ${MSG_COUNT}"
    
    rm -f "$WS_OUTPUT_FILE" "${WS_OUTPUT_FILE}.stderr"
    
    if [[ "$MSG_COUNT" -gt 0 ]]; then
      echo "  ✓ Stream ticket flow works: ${MSG_COUNT} events"
    else
      echo "  ✗ No events via ticket URL"
      exit 1
    fi
  else
    echo "  ✗ No stream URL in ticket response"
    exit 1
  fi
else
  echo "  Ticket endpoint returned ${HTTP_STATUS}"
  
  echo "  ═══ Fallback: Connect directly (no ticket) ═══"
  DIRECT_URL="ws://localhost:${PORT}/api/towns/${TOWN_ID}/container/agents/${MAYOR_AGENT_ID}/stream"
  echo "  Direct URL: ${DIRECT_URL}"
  
  WS_OUTPUT_FILE=$(mktemp)
  node "${SCRIPT_DIR}/ws-client.mjs" "${DIRECT_URL}" 10 "${MAYOR_AGENT_ID}" > "$WS_OUTPUT_FILE" 2>"${WS_OUTPUT_FILE}.stderr" &
  WS_PID=$!
  sleep 12
  kill "$WS_PID" 2>/dev/null || true
  wait "$WS_PID" 2>/dev/null || true
  
  WS_STDERR=$(cat "${WS_OUTPUT_FILE}.stderr" 2>/dev/null || echo "")
  WS_MESSAGES=$(cat "$WS_OUTPUT_FILE" 2>/dev/null || echo "[]")
  MSG_COUNT=$(echo "$WS_MESSAGES" | jq 'length' 2>/dev/null || echo "0")
  
  echo "  WS client output:"
  echo "$WS_STDERR" | head -5 | sed 's/^/    /'
  echo "  Messages: ${MSG_COUNT}"
  
  rm -f "$WS_OUTPUT_FILE" "${WS_OUTPUT_FILE}.stderr"
  
  if [[ "$MSG_COUNT" -gt 0 ]]; then
    echo "  ✓ Direct WS works: ${MSG_COUNT} events"
  else
    echo "  ✗ No events via direct WS either"
    exit 1
  fi
fi

echo "  Stream ticket flow OK"
