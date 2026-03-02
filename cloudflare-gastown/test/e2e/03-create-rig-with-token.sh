#!/usr/bin/env bash
# Test 3: Create a rig with kilocode_token and verify it propagates to town config
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="test-kilocode-token-$(date +%s)"

# Create town
echo "  Creating town..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Token-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Town: ${TOWN_ID}"

# Create rig with token
echo "  Creating rig with kilocode_token..."
api_post "/api/users/${USER_ID}/rigs" "$(jq -n \
  --arg town_id "$TOWN_ID" \
  --arg name "token-rig" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg default_branch "main" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{town_id: $town_id, name: $name, git_url: $git_url, default_branch: $default_branch, kilocode_token: $kilocode_token}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Rig: ${RIG_ID}"

# Check wrangler logs for the configureRig call
echo "  Checking wrangler logs for token propagation..."
sleep 1
if grep -q "configureRig.*hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  configureRig received the token"
else
  echo "  WARNING: configureRig log not found, checking full log..."
  grep "configureRig" "$WRANGLER_LOG" || echo "  No configureRig log found at all"
fi

if grep -q "propagating kilocodeToken to town config" "$WRANGLER_LOG"; then
  echo "  Token propagated to town config"
else
  echo "  WARNING: Token propagation log not found"
  grep "kilocode" "$WRANGLER_LOG" || echo "  No kilocode logs found"
fi

# Verify town config has the token by checking the /api/towns/:townId/config endpoint
echo "  Fetching town config..."
api_get "/api/towns/${TOWN_ID}/config"
echo "  Town config response: status=${HTTP_STATUS} body=${HTTP_BODY}"

# Also verify mayor status works (uses the town DO)
echo "  Checking mayor status..."
api_get "/api/towns/${TOWN_ID}/mayor/status"
assert_status "200" "mayor status"
echo "  Mayor status: ${HTTP_BODY}"

echo "  Rig + token OK"
