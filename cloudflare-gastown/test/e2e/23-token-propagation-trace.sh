#!/usr/bin/env bash
# Test 23: Detailed token propagation trace
# Creates a rig with a known token and traces it through every layer
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
KNOWN_TOKEN="e2e-trace-token-KNOWN-$(date +%s)"

echo "  ═══ Step 1: Create town ═══"
api_post "/api/users/${USER_ID}/towns" '{"name":"Token-Trace-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Town: ${TOWN_ID}"

echo "  ═══ Step 2: Check town config BEFORE rig creation ═══"
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "get config before"
BEFORE_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Town config kilocode_token before rig: ${BEFORE_TOKEN}"
assert_eq "$BEFORE_TOKEN" "NONE" "should have no token before rig creation"

echo "  ═══ Step 3: Create rig with known token ═══"
RIG_BODY=$(jq -n \
  --arg town_id "$TOWN_ID" \
  --arg name "trace-rig" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$KNOWN_TOKEN" \
  '{town_id: $town_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')
echo "  POST body: ${RIG_BODY}"
api_post "/api/users/${USER_ID}/rigs" "$RIG_BODY"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Rig: ${RIG_ID}"

echo "  ═══ Step 4: Check town config AFTER rig creation ═══"
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "get config after"
AFTER_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo "  Town config kilocode_token after rig: ${AFTER_TOKEN}"

if [[ "$AFTER_TOKEN" == "NONE" || -z "$AFTER_TOKEN" ]]; then
  echo "  FAIL: Token was NOT propagated to town config!"
  echo "  Full town config: ${HTTP_BODY}"
  
  echo ""
  echo "  ═══ Checking wrangler logs for clues ═══"
  echo "  configureRig logs:"
  grep "configureRig" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"
  echo "  kilocode/token logs:"
  grep -i "kilocode\|token" "$WRANGLER_LOG" | head -15 | sed 's/^/    /' || echo "    (none)"
  echo "  Town DO update logs:"
  grep "updateTownConfig\|propagating" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"
  
  exit 1
fi

assert_eq "$AFTER_TOKEN" "$KNOWN_TOKEN" "token should match the known token"

echo "  ═══ Step 5: Send mayor message and check container receives token ═══"
CURRENT_TOWN_ID="$TOWN_ID"
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Token trace test"}'
assert_status "200" "send mayor message"

sleep 15

echo "  Checking wrangler logs for X-Town-Config..."
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  ✓ X-Town-Config delivered with token"
else
  echo "  ✗ X-Town-Config did NOT have token"
  grep "X-Town-Config\|hasKilocodeToken" "$WRANGLER_LOG" | sed 's/^/    /' || echo "    (none)"
  exit 1
fi

echo "  Checking container for KILO_CONFIG_CONTENT..."
for cid in $(docker ps -q 2>/dev/null); do
  if docker logs "$cid" 2>&1 | grep -q "KILO_CONFIG_CONTENT set"; then
    echo "  ✓ Container $cid: KILO_CONFIG_CONTENT set"
    break
  fi
done

echo "  Token propagation trace OK"
