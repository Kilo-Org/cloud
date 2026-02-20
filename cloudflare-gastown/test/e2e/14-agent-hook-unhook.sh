#!/usr/bin/env bash
# Test 14: Hook and unhook an agent from a bead
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

api_post "/api/users/${USER_ID}/towns" '{"name":"Hook-Town"}'
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg town_id "$TOWN_ID" \
  '{town_id: $town_id, name: "hook-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Register agent and create bead
api_post "/api/rigs/${RIG_ID}/agents" '{"role":"polecat","name":"HookPolecat","identity":"hook-1"}'
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/rigs/${RIG_ID}/beads" '{"type":"issue","title":"Hook bead"}'
BEAD_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Hooking agent to bead..."
api_post "/api/rigs/${RIG_ID}/agents/${AGENT_ID}/hook" "{\"bead_id\":\"${BEAD_ID}\"}"
assert_status "200" "hook agent"

# Verify agent has the hook
api_get "/api/rigs/${RIG_ID}/agents/${AGENT_ID}"
assert_json "$HTTP_BODY" ".data.current_hook_bead_id" "$BEAD_ID" "agent should be hooked"

# Verify bead is in_progress
api_get "/api/rigs/${RIG_ID}/beads/${BEAD_ID}"
assert_json "$HTTP_BODY" ".data.status" "in_progress" "bead should be in_progress"

echo "  Unhooking agent..."
api_call DELETE "/api/rigs/${RIG_ID}/agents/${AGENT_ID}/hook"
assert_status "200" "unhook agent"

# Verify agent is unhooked
api_get "/api/rigs/${RIG_ID}/agents/${AGENT_ID}"
assert_json "$HTTP_BODY" ".data.current_hook_bead_id" "null" "agent should be unhooked"

echo "  Hook/unhook OK"
