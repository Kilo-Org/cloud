#!/usr/bin/env bash
# Test 12: Register an agent and list agents
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

api_post "/api/users/${USER_ID}/towns" '{"name":"Agent-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg town_id "$TOWN_ID" \
  '{town_id: $town_id, name: "agent-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Registering agent..."
api_post "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents" '{"role":"polecat","name":"TestPolecat","identity":"test-polecat-1"}'
assert_status "201" "register agent"
assert_json "$HTTP_BODY" ".data.role" "polecat" "agent role"
assert_json "$HTTP_BODY" ".data.name" "TestPolecat" "agent name"
assert_json "$HTTP_BODY" ".data.status" "idle" "agent should be idle"
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Agent: ${AGENT_ID}"

echo "  Listing agents..."
api_get "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents"
assert_status "200" "list agents"
AGENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$AGENT_COUNT" "1" "should have 1 agent"

echo "  Getting agent by ID..."
api_get "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents/${AGENT_ID}"
assert_status "200" "get agent"
assert_json "$HTTP_BODY" ".data.id" "$AGENT_ID" "agent id"

echo "  Agent register OK"
