#!/usr/bin/env bash
# Test 7: List rigs for a town
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating town..."
api_post "/api/users/${USER_ID}/towns" '{"name":"List-Rigs-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Listing rigs (should be empty)..."
api_get "/api/users/${USER_ID}/towns/${TOWN_ID}/rigs"
assert_status "200" "list rigs"
RIG_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$RIG_COUNT" "0" "should have 0 rigs initially"

echo "  Creating two rigs..."
api_post "/api/users/${USER_ID}/rigs" "$(jq -n \
  --arg town_id "$TOWN_ID" '{town_id: $town_id, name: "rig-a", git_url: "https://github.com/a/a.git", default_branch: "main"}')"
assert_status "201" "create rig a"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n \
  --arg town_id "$TOWN_ID" '{town_id: $town_id, name: "rig-b", git_url: "https://github.com/b/b.git", default_branch: "main"}')"
assert_status "201" "create rig b"

echo "  Listing rigs (should have 2)..."
api_get "/api/users/${USER_ID}/towns/${TOWN_ID}/rigs"
assert_status "200" "list rigs after creation"
RIG_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$RIG_COUNT" "2" "should have 2 rigs"

echo "  List rigs OK"
