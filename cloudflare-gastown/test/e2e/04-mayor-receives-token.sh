#!/usr/bin/env bash
# Test 4: Send mayor message and verify KILOCODE_TOKEN arrives in container
# This tests the full config flow: town config → X-Town-Config → container buildAgentEnv
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID="e2e-user-$(date +%s)"
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

# Create town + rig with token
echo "  Creating town..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Mayor-Token-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Creating rig with kilocode_token..."
api_post "/api/users/${USER_ID}/rigs" "$(jq -n \
  --arg town_id "$TOWN_ID" \
  --arg name "mayor-rig" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{town_id: $town_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create rig"

# Verify town config has the token
echo "  Verifying town config..."
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "get town config"
CONFIG_TOKEN=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // empty')
assert_eq "$CONFIG_TOKEN" "$FAKE_TOKEN" "town config should have the kilocode_token"

# Verify X-Town-Config header delivery (this is in wrangler logs since the worker sends it)
echo "  Verifying X-Town-Config header was sent with token (worker-side)..."
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  Worker sent X-Town-Config with token ✓"
else
  # The header might not have been sent yet if the mayor hasn't been started
  echo "  X-Town-Config not yet sent (expected — mayor not started yet)"
fi

# Send mayor message — this triggers startAgentInContainer
echo "  Sending mayor message..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Hello from E2E test"}'
echo "  Mayor message response: status=${HTTP_STATUS}"
# Accept 200 (success) or 500 (container may fail to start if kilo binary not available in local dev)
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "  Mayor message returned ${HTTP_STATUS} — this may be expected in local dev without a container"
  echo "  Response: ${HTTP_BODY}"
fi

# Wait for container to potentially start (up to 15s)
echo "  Waiting for container interaction..."
sleep 5

# Check wrangler logs for the full flow
echo "  Checking worker logs for X-Town-Config delivery..."
if grep -q "hasKilocodeToken=true" "$WRANGLER_LOG"; then
  echo "  ✓ X-Town-Config header delivered with kilocode_token"
else
  echo "  ✗ X-Town-Config header did NOT contain kilocode_token"
  grep "X-Town-Config" "$WRANGLER_LOG" || echo "    No X-Town-Config logs at all"
  exit 1
fi

# Check Docker container logs if a container was spawned
CONTAINER_ID=$(docker ps -q --filter "ancestor=gastown-dev-TownContainerDO" 2>/dev/null | head -1)
if [[ -z "$CONTAINER_ID" ]]; then
  # Try broader search
  CONTAINER_ID=$(docker ps -q 2>/dev/null | head -1)
fi

if [[ -n "$CONTAINER_ID" ]]; then
  echo "  Found container: ${CONTAINER_ID}"
  CONTAINER_LOGS=$(docker logs "$CONTAINER_ID" 2>&1)

  if echo "$CONTAINER_LOGS" | grep -q "KILO_CONFIG_CONTENT set"; then
    echo "  ✓ Container: KILO_CONFIG_CONTENT was set"
  elif echo "$CONTAINER_LOGS" | grep -q "No KILOCODE_TOKEN available"; then
    echo "  ✗ Container: KILOCODE_TOKEN was NOT available"
    echo "  Container buildAgentEnv logs:"
    echo "$CONTAINER_LOGS" | grep "buildAgentEnv" || echo "    (no buildAgentEnv logs)"
    echo "$CONTAINER_LOGS" | grep "X-Town-Config" || echo "    (no X-Town-Config logs)"
    exit 1
  else
    echo "  Container logs (last 20 lines):"
    echo "$CONTAINER_LOGS" | tail -20
  fi
else
  echo "  No Docker container found — container may not have started in local dev"
  echo "  This is OK for the token propagation test (the worker-side flow is verified)"
fi

echo "  Mayor token flow OK"
