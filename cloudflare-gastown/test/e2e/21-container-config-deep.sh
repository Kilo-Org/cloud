#!/usr/bin/env bash
# Test 21: Deep verification that container receives config and kilo serve starts correctly
# Inspects every layer: town config → X-Town-Config → container env → kilo serve
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-deep-token-$(date +%s)"

# Clean slate
docker ps -q 2>/dev/null | xargs -r docker kill 2>/dev/null || true
sleep 2

echo "  ═══ Setup: Create town + rig + config ═══"
api_post "/api/users/${USER_ID}/towns" '{"name":"Deep-Config-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" --arg tk "$FAKE_TOKEN" \
  '{town_id: $t, name: "deep-rig", git_url: "https://github.com/test/repo.git", default_branch: "main", kilocode_token: $tk}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  ═══ Layer 1: Verify town config has token ═══"
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "get config"
CONFIG_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // empty')
if [[ "$CONFIG_TOKEN" != "$FAKE_TOKEN" ]]; then
  echo "  FAIL Layer 1: token not in town config (got: '${CONFIG_TOKEN}')"
  exit 1
fi
echo "  ✓ Layer 1: Town config has kilocode_token"

echo "  ═══ Layer 2: Send mayor message and wait for container ═══"
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Deep config test"}'
assert_status "200" "send mayor message"
MAYOR_AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  Mayor agent: ${MAYOR_AGENT_ID}"

# Wait for container to fully start
echo "  Waiting for container startup (20s)..."
sleep 20

echo "  ═══ Layer 3: Verify X-Town-Config delivery (worker logs) ═══"
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  ✓ Layer 3: Worker sent X-Town-Config with kilocode_token"
else
  echo "  FAIL Layer 3: X-Town-Config header did not contain kilocode_token"
  echo "  Worker logs for X-Town-Config:"
  grep "X-Town-Config\|kilocode\|configureRig" "$WRANGLER_LOG" || echo "  (none)"
  exit 1
fi

echo "  ═══ Layer 4: Inspect ALL container logs ═══"
CONTAINERS=$(docker ps -q 2>/dev/null)
if [[ -z "$CONTAINERS" ]]; then
  echo "  FAIL Layer 4: No containers running"
  echo "  Wrangler log tail:"
  tail -30 "$WRANGLER_LOG"
  exit 1
fi

FOUND_CONFIG=false
FOUND_SERVER=false
FOUND_AGENT=false
for cid in $CONTAINERS; do
  CLOG=$(docker logs "$cid" 2>&1)
  echo ""
  echo "  --- Container $cid (last 30 lines) ---"
  echo "$CLOG" | tail -30 | sed 's/^/    /'
  echo "  ---"
  
  if echo "$CLOG" | grep -q "X-Town-Config received"; then
    echo "  ✓ Container $cid: X-Town-Config received"
    FOUND_CONFIG=true
    
    # Check if token was in the config
    if echo "$CLOG" | grep -q "hasKilocodeToken=true"; then
      echo "  ✓ Container $cid: kilocode_token present in config"
    else
      echo "  ✗ Container $cid: kilocode_token MISSING from config"
      echo "    Config log:"
      echo "$CLOG" | grep "X-Town-Config\|kilocode" | sed 's/^/      /'
    fi
  fi
  
  if echo "$CLOG" | grep -q "KILO_CONFIG_CONTENT set"; then
    echo "  ✓ Container $cid: KILO_CONFIG_CONTENT set"
    FOUND_CONFIG=true
  fi
  
  if echo "$CLOG" | grep -q "SDK server started"; then
    echo "  ✓ Container $cid: SDK server started"
    FOUND_SERVER=true
  fi
  
  if echo "$CLOG" | grep -q "Started agent"; then
    echo "  ✓ Container $cid: Agent started"
    FOUND_AGENT=true
  fi

  if echo "$CLOG" | grep -q "FAILED\|error\|Error"; then
    echo "  ⚠ Container $cid: Errors detected:"
    echo "$CLOG" | grep -i "FAILED\|error" | head -5 | sed 's/^/      /'
  fi
done

echo ""
echo "  ═══ Layer 5: Summary ═══"
echo "  Config received:  $FOUND_CONFIG"
echo "  Server started:   $FOUND_SERVER"
echo "  Agent started:    $FOUND_AGENT"

if [[ "$FOUND_CONFIG" != "true" ]]; then
  echo "  FAIL: Container never received config"
  exit 1
fi
if [[ "$FOUND_SERVER" != "true" ]]; then
  echo "  FAIL: SDK server never started"
  exit 1
fi
if [[ "$FOUND_AGENT" != "true" ]]; then
  echo "  FAIL: Agent never started"
  exit 1
fi

echo "  Deep config verification OK"
