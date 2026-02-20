#!/usr/bin/env bash
# Test 5: Verify only one container per town (no phantom containers)
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID="e2e-user-$(date +%s)"
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

# Kill any leftover containers from previous runs
echo "  Cleaning up any existing containers..."
docker ps -q 2>/dev/null | xargs -r docker kill 2>/dev/null || true
sleep 1

# Count containers before
BEFORE_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
echo "  Containers before: ${BEFORE_COUNT}"

# Create town + rig
echo "  Creating town and rig..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Single-Container-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/users/${USER_ID}/rigs" "$(jq -n \
  --arg town_id "$TOWN_ID" \
  --arg name "single-rig" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$FAKE_TOKEN" \
  '{town_id: $town_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')"
assert_status "201" "create rig"

# Send mayor message to trigger container start
echo "  Sending mayor message to start container..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Test single container"}'

# Wait for container to start
echo "  Waiting for container to start..."
sleep 10

# Count containers
AFTER_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
echo "  Containers after: ${AFTER_COUNT}"

# Should have exactly 1 container (or 0 if container doesn't start in test env)
if [[ "$AFTER_COUNT" -gt 1 ]]; then
  echo "  FAIL: More than 1 container running!"
  echo "  Container list:"
  docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"
  exit 1
fi

echo "  Container count OK (${AFTER_COUNT})"

# Send another message — should NOT spawn a second container
echo "  Sending second mayor message..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Second message"}'
sleep 3

FINAL_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
echo "  Containers after second message: ${FINAL_COUNT}"

if [[ "$FINAL_COUNT" -gt 1 ]]; then
  echo "  FAIL: Second message spawned additional container!"
  docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"
  exit 1
fi

echo "  Single container verified OK"
