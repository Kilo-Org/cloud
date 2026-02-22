#!/usr/bin/env bash
# Test 13: Sling a bead (atomic create bead + assign agent)
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

api_post "/api/users/${USER_ID}/towns" '{"name":"Sling-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg town_id "$TOWN_ID" \
  '{town_id: $town_id, name: "sling-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Slinging bead..."
api_post "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/sling" '{"title":"Slung bead","body":"Do something","priority":"high"}'
assert_status "201" "sling bead"
assert_json_exists "$HTTP_BODY" ".data.bead.id" "slung bead should have id"
assert_json_exists "$HTTP_BODY" ".data.agent.id" "slung bead should have agent"
assert_json "$HTTP_BODY" ".data.bead.status" "in_progress" "slung bead should be in_progress"

BEAD_ID=$(echo "$HTTP_BODY" | jq -r '.data.bead.id')
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agent.id')
echo "  Slung bead=${BEAD_ID} → agent=${AGENT_ID}"

# Verify agent is hooked to the bead
echo "  Checking agent hook..."
api_get "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents/${AGENT_ID}"
assert_status "200" "get agent"
assert_json "$HTTP_BODY" ".data.current_hook_bead_id" "$BEAD_ID" "agent should be hooked to bead"

echo "  Sling OK"
