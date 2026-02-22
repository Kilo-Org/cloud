#!/usr/bin/env bash
# Test 5: Verify sending multiple messages to the same town doesn't spawn extra containers
# (Each town gets exactly one TownContainerDO, so repeated messages should reuse it)
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-kilo-token-$(date +%s)"

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

# Snapshot container count before first message
BEFORE_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')

# Send first mayor message to trigger container start
echo "  Sending first mayor message..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Test single container"}'
assert_status "200" "first message"

# Wait for container to start
sleep 10

AFTER_FIRST=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
FIRST_DELTA=$((AFTER_FIRST - BEFORE_COUNT))
echo "  Containers after first message: ${AFTER_FIRST} (delta: +${FIRST_DELTA})"

# Send a second message to the same town — should NOT spawn additional containers
echo "  Sending second mayor message to same town..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"Second message"}'
assert_status "200" "second message"
sleep 5

AFTER_SECOND=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
SECOND_DELTA=$((AFTER_SECOND - AFTER_FIRST))
echo "  Containers after second message: ${AFTER_SECOND} (delta from first: +${SECOND_DELTA})"

if [[ "$SECOND_DELTA" -gt 0 ]]; then
  echo "  FAIL: Second message to the same town spawned ${SECOND_DELTA} additional container(s)!"
  docker ps --format "table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}"
  exit 1
fi

echo "  Same-town container reuse verified OK"
