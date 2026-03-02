#!/usr/bin/env bash
# Test 17: Multiple towns per user are independent
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating two towns..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Town-Alpha"}'
assert_status "201" "create town alpha"
TOWN_A=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/towns" '{"name":"Town-Beta"}'
assert_status "201" "create town beta"
TOWN_B=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Verifying both exist..."
api_get "/api/users/${USER_ID}/towns"
TOWN_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$TOWN_COUNT" "2" "should have 2 towns"

echo "  Deleting town alpha..."
api_call DELETE "/api/users/${USER_ID}/towns/${TOWN_A}"
assert_status "200" "delete town alpha"

echo "  Town beta should still exist..."
api_get "/api/users/${USER_ID}/towns/${TOWN_B}"
assert_status "200" "town beta still exists"
assert_json "$HTTP_BODY" ".data.name" "Town-Beta" "town beta name"

api_get "/api/users/${USER_ID}/towns"
TOWN_COUNT2=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$TOWN_COUNT2" "1" "should have 1 town left"

echo "  Multiple towns OK"
