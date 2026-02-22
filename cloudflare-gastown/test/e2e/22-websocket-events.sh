#!/usr/bin/env bash
# Test 22: WebSocket event flow — verify events from container reach the client
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-ws-token-$(date +%s)"

# Clean slate
docker ps -q 2>/dev/null | xargs -r docker kill 2>/dev/null || true
sleep 2

echo "  ═══ Setup ═══"
api_post "/api/users/${USER_ID}/towns" '{"name":"WS-Events-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" --arg tk "$FAKE_TOKEN" \
  '{town_id: $t, name: "ws-rig", git_url: "https://github.com/test/repo.git", default_branch: "main", kilocode_token: $tk}')"
assert_status "201" "create rig"

echo "  ═══ Step 1: Send mayor message to start agent ═══"
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Say hello world in one sentence"}'
assert_status "200" "send mayor message"
MAYOR_AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  Mayor agent: ${MAYOR_AGENT_ID}"

echo "  ═══ Step 2: Wait for container to start and agent to process (20s) ═══"
sleep 20

echo "  ═══ Step 3: Connect WebSocket via the correct worker route ═══"
# The correct WS URL goes through the worker's fetch handler which proxies to TownContainerDO
WS_URL="ws://localhost:${PORT}/api/towns/${TOWN_ID}/container/agents/${MAYOR_AGENT_ID}/stream"
echo "  Connecting to: ${WS_URL}"

# Run WebSocket client in background, collect events for 15 seconds
WS_OUTPUT_FILE=$(mktemp)
node "${SCRIPT_DIR}/ws-client.mjs" "${WS_URL}" 15 "${MAYOR_AGENT_ID}" > "$WS_OUTPUT_FILE" 2>"${WS_OUTPUT_FILE}.stderr" &
WS_PID=$!

echo "  WebSocket client PID: ${WS_PID}, collecting for 15s..."
sleep 17

if kill -0 "$WS_PID" 2>/dev/null; then
  kill "$WS_PID" 2>/dev/null || true
fi
wait "$WS_PID" 2>/dev/null || true

echo "  ═══ Step 4: Analyze results ═══"
WS_STDERR=$(cat "${WS_OUTPUT_FILE}.stderr" 2>/dev/null || echo "")
WS_MESSAGES=$(cat "$WS_OUTPUT_FILE" 2>/dev/null || echo "[]")

echo "  WS client stderr:"
echo "$WS_STDERR" | sed 's/^/    /'

MSG_COUNT=$(echo "$WS_MESSAGES" | jq 'length' 2>/dev/null || echo "0")
echo "  Messages received: ${MSG_COUNT}"

echo "  ═══ Step 5: Check container logs for event subscription ═══"
for cid in $(docker ps -q 2>/dev/null); do
  CLOG=$(docker logs "$cid" 2>&1)
  echo ""
  echo "  Container $cid event-related logs:"
  echo "$CLOG" | grep -i "subscrib\|event.*#\|broadcastEvent\|Event.*agent\|WebSocket\|No event stream" | head -20 | sed 's/^/    /' || echo "    (none)"
  
  if echo "$CLOG" | grep -q "Event #1"; then
    echo "  ✓ Container $cid: SDK events are being received"
  else
    echo "  ✗ Container $cid: No SDK events observed"
  fi
done

rm -f "$WS_OUTPUT_FILE" "${WS_OUTPUT_FILE}.stderr"

if [[ "$MSG_COUNT" -gt 0 ]]; then
  echo ""
  echo "  ✓ WebSocket events flowing: ${MSG_COUNT} messages"
  echo "  First few types:"
  echo "$WS_MESSAGES" | jq -r '.[0:5][] | .type // .event // "unknown"' 2>/dev/null | sed 's/^/    /'
else
  echo ""
  echo "  ✗ No WebSocket events received by client"
  echo "  Possible causes:"
  echo "    - SDK event.subscribe() didn't return events"
  echo "    - Events not broadcast to WS sinks"
  echo "    - TownContainerDO relay not connected"
  echo "    - Worker WebSocket interception failed"
  exit 1
fi

echo "  WebSocket events OK"
