#!/usr/bin/env bash
# Test 25: Create a rig WITHOUT kilocode_token and verify behavior
# This simulates what happens if the token generation fails or is omitted
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  ═══ Step 1: Create town ═══"
api_post "/api/users/${USER_ID}/towns" '{"name":"No-Token-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  ═══ Step 2: Create rig WITHOUT kilocode_token ═══"
api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" \
  '{town_id: $t, name: "no-token-rig", git_url: "https://github.com/test/repo.git", default_branch: "main"}')"
assert_status "201" "create rig without token"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Rig: ${RIG_ID}"

echo "  ═══ Step 3: Check town config (should have no token) ═══"
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "get config"
TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Town config kilocode_token: ${TOKEN}"
# Token should be NONE since we didn't pass one
assert_eq "$TOKEN" "NONE" "should have no token when rig created without one"

echo "  ═══ Step 4: Check wrangler logs for configureRig ═══"
echo "  configureRig logs:"
grep "configureRig" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"

echo "  No-token rig OK"
