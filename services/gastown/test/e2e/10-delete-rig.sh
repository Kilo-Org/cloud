#!/usr/bin/env bash
# Test 10: Delete a rig from a town
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating town + rig..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Del-Rig-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg town_id "$TOWN_ID" \
  '{town_id: $town_id, name: "del-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Deleting rig ${RIG_ID}..."
api_call DELETE "/api/users/${USER_ID}/rigs/${RIG_ID}"
assert_status "200" "delete rig"

echo "  Listing rigs (should be empty)..."
api_get "/api/users/${USER_ID}/towns/${TOWN_ID}/rigs"
assert_status "200" "list rigs"
RIG_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$RIG_COUNT" "0" "should have 0 rigs after delete"

echo "  Delete rig OK"
