#!/usr/bin/env bash
# Test 16: Bead events are recorded when beads change status
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
api_post "/api/users/${USER_ID}/towns" '{"name":"Events-Town"}'
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" '{town_id: $t, name: "ev-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Sling a bead (creates bead + hooks agent → generates 'created' and 'hooked' events)
echo "  Slinging bead..."
api_post "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/sling" '{"title":"Event bead"}'
assert_status "201" "sling"
BEAD_ID=$(echo "$HTTP_BODY" | jq -r '.data.bead.id')

echo "  Fetching bead events..."
api_get "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/events"
assert_status "200" "bead events"
EVENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
echo "  Events: ${EVENT_COUNT}"

# Should have at least 'created' and 'hooked' events
if [[ "$EVENT_COUNT" -lt 2 ]]; then
  echo "  FAIL: expected at least 2 events, got ${EVENT_COUNT}"
  echo "  Events: ${HTTP_BODY}"
  exit 1
fi

echo "  Bead events OK"
