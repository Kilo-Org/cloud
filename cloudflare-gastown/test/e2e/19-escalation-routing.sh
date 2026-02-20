#!/usr/bin/env bash
# Test 19: Escalation beads — create an escalation-type bead, list escalations
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
api_post "/api/users/${USER_ID}/towns" '{"name":"Escalation-Town"}'
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" '{town_id: $t, name: "esc-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Creating escalation bead..."
api_post "/api/rigs/${RIG_ID}/escalations" '{"title":"Agent stuck","body":"Stuck for 30 min","priority":"high"}'
assert_status "201" "create escalation"
ESC_BEAD_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
assert_json "$HTTP_BODY" ".data.type" "escalation" "type should be escalation"
echo "  Escalation bead: ${ESC_BEAD_ID}"

echo "  Listing town escalations..."
api_get "/api/towns/${TOWN_ID}/escalations"
assert_status "200" "list escalations"
# Town-level escalations are routed via routeEscalation — this is a separate system
# The bead we created above is in the beads table, not the escalations table

echo "  Listing beads to find escalation..."
api_get "/api/rigs/${RIG_ID}/beads"
assert_status "200" "list beads"
ESC_COUNT=$(echo "$HTTP_BODY" | jq '[.data[] | select(.type == "escalation")] | length')
assert_eq "$ESC_COUNT" "1" "should have 1 escalation bead"

echo "  Escalation routing OK"
