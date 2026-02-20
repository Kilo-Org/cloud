#!/usr/bin/env bash
# Test 11: Create, list, and close beads via the agent-authenticated API
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

# Setup: town + rig
api_post "/api/users/${USER_ID}/towns" '{"name":"Bead-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg town_id "$TOWN_ID" --arg t "$FAKE_TOKEN" \
  '{town_id: $town_id, name: "bead-rig", git_url: "https://github.com/t/r.git", default_branch: "main", kilocode_token: $t}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Set town ID for X-Town-Id header (needed since dev mode has no JWT)
CURRENT_TOWN_ID="$TOWN_ID"

echo "  Creating bead..."
api_post "/api/rigs/${RIG_ID}/beads" '{"type":"issue","title":"E2E test bead","body":"Test body","priority":"high"}'
assert_status "201" "create bead"
assert_json_exists "$HTTP_BODY" ".data.id" "bead should have id"
assert_json "$HTTP_BODY" ".data.title" "E2E test bead" "bead title"
assert_json "$HTTP_BODY" ".data.status" "open" "bead status should be open"
BEAD_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Bead: ${BEAD_ID}"

echo "  Listing beads..."
api_get "/api/rigs/${RIG_ID}/beads"
assert_status "200" "list beads"
BEAD_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$BEAD_COUNT" "1" "should have 1 bead"

echo "  Getting bead by ID..."
api_get "/api/rigs/${RIG_ID}/beads/${BEAD_ID}"
assert_status "200" "get bead"
assert_json "$HTTP_BODY" ".data.id" "$BEAD_ID" "bead id should match"

echo "  Bead CRUD OK"
