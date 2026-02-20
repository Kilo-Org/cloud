#!/usr/bin/env bash
# Test 2: Create a town and verify it's returned correctly
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating town for user=${USER_ID}..."
api_post "/api/users/${USER_ID}/towns" '{"name":"E2E-Town"}'
assert_status "201" "POST /api/users/:userId/towns should return 201"
assert_json "$HTTP_BODY" ".success" "true" "response should have success=true"
assert_json_exists "$HTTP_BODY" ".data.id" "town should have an id"
assert_json "$HTTP_BODY" ".data.name" "E2E-Town" "town name should match"
assert_json "$HTTP_BODY" ".data.owner_user_id" "$USER_ID" "owner should match"

TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Created town: ${TOWN_ID}"

echo "  Listing towns for user..."
api_get "/api/users/${USER_ID}/towns"
assert_status "200" "GET /api/users/:userId/towns should return 200"
assert_json "$HTTP_BODY" ".success" "true" "list response should have success=true"

TOWN_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$TOWN_COUNT" "1" "should have 1 town"

echo "  Getting town by ID..."
api_get "/api/users/${USER_ID}/towns/${TOWN_ID}"
assert_status "200" "GET /api/users/:userId/towns/:townId should return 200"
assert_json "$HTTP_BODY" ".data.id" "$TOWN_ID" "fetched town id should match"

echo "  Town CRUD OK"
