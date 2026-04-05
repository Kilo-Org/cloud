#!/usr/bin/env bash
# Test 6: Mayor status shows session after sending a message
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

echo "  Setup: creating town + rig..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Mayor-Status-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/rigs" "$(jq -n \
  --arg town_id "$TOWN_ID" \
  --arg name "status-rig" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{town_id: $town_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create rig"

# Before sending a message, mayor status should have no session
echo "  Checking mayor status before message..."
api_get "/api/towns/${TOWN_ID}/mayor/status"
assert_status "200" "mayor status before"
assert_json "$HTTP_BODY" ".data.configured" "true" "should be configured"
assert_json "$HTTP_BODY" ".data.session" "null" "session should be null before first message"

# Send message to create mayor session
echo "  Sending mayor message..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Status test"}'
assert_status "200" "send mayor message"
assert_json_exists "$HTTP_BODY" ".data.agentId" "should return agentId"

AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  Mayor agentId: ${AGENT_ID}"

# After sending, mayor status should have a session
echo "  Checking mayor status after message..."
sleep 2
api_get "/api/towns/${TOWN_ID}/mayor/status"
assert_status "200" "mayor status after"
assert_json "$HTTP_BODY" ".data.configured" "true" "should be configured"
assert_json_exists "$HTTP_BODY" ".data.session" "session should exist after message"
assert_json "$HTTP_BODY" ".data.session.agentId" "$AGENT_ID" "session agentId should match"

SESSION_STATUS=$(echo "$HTTP_BODY" | jq -r '.data.session.status')
echo "  Mayor session status: ${SESSION_STATUS}"
# Status should be 'active' or 'starting' (not 'idle' since we just sent a message)
if [[ "$SESSION_STATUS" != "active" && "$SESSION_STATUS" != "starting" && "$SESSION_STATUS" != "idle" ]]; then
  echo "  FAIL: unexpected session status: ${SESSION_STATUS}"
  exit 1
fi

echo "  Mayor status OK"
