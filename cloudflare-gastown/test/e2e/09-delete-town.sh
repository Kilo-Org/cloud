#!/usr/bin/env bash
# Test 9: Delete a town
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating town..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Delete-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Deleting town..."
api_call DELETE "/api/users/${USER_ID}/towns/${TOWN_ID}"
assert_status "200" "delete town"

echo "  Verifying town is gone..."
api_get "/api/users/${USER_ID}/towns/${TOWN_ID}"
assert_status "404" "deleted town should return 404"

echo "  Listing towns (should be empty)..."
api_get "/api/users/${USER_ID}/towns"
assert_status "200" "list towns after delete"
TOWN_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$TOWN_COUNT" "0" "should have 0 towns after delete"

echo "  Delete town OK"
