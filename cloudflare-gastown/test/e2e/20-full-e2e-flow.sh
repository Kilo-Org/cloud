#!/usr/bin/env bash
# Test 20: Full end-to-end flow — town → rig → config → mayor → container → agent
# This is the most comprehensive test, exercising the entire system.
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-full-token-$(date +%s)"

# Kill any leftover containers from previous tests
docker ps -q 2>/dev/null | xargs -r docker kill 2>/dev/null || true
sleep 2

echo "  ═══ Step 1: Create town ═══"
api_post "/api/users/${USER_ID}/towns" '{"name":"Full-E2E-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"
echo "  Town: ${TOWN_ID}"

echo "  ═══ Step 2: Set town config ═══"
api_call PATCH "/api/towns/${TOWN_ID}/config" '{"default_model":"anthropic/claude-sonnet-4.6","env_vars":{"PROJECT":"e2e-test"}}'
assert_status "200" "update config"
assert_json "$HTTP_BODY" ".data.default_model" "anthropic/claude-sonnet-4.6" "model set"

echo "  ═══ Step 3: Create rig with token ═══"
api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" --arg tk "$FAKE_TOKEN" \
  '{town_id: $t, name: "e2e-rig", git_url: "https://github.com/test/e2e.git", default_branch: "main", kilocode_token: $tk}')"
assert_status "201" "create rig"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Rig: ${RIG_ID}"

echo "  ═══ Step 4: Verify token in town config ═══"
api_get "/api/towns/${TOWN_ID}/config"
assert_json "$HTTP_BODY" ".data.kilocode_token" "$FAKE_TOKEN" "token in town config"
echo "  Token confirmed in town config"

echo "  ═══ Step 5: Create beads ═══"
api_post "/api/rigs/${RIG_ID}/beads" '{"type":"issue","title":"Build login page","priority":"high"}'
assert_status "201" "create bead 1"
BEAD1_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/rigs/${RIG_ID}/beads" '{"type":"issue","title":"Fix sidebar CSS","priority":"medium"}'
assert_status "201" "create bead 2"

echo "  ═══ Step 6: Register agent and hook to bead ═══"
api_post "/api/rigs/${RIG_ID}/agents" '{"role":"polecat","name":"E2E-Polecat","identity":"e2e-pc-1"}'
assert_status "201" "register agent"
AGENT_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/rigs/${RIG_ID}/agents/${AGENT_ID}/hook" "{\"bead_id\":\"${BEAD1_ID}\"}"
assert_status "200" "hook agent"

# Verify bead is in_progress
api_get "/api/rigs/${RIG_ID}/beads/${BEAD1_ID}"
assert_json "$HTTP_BODY" ".data.status" "in_progress" "bead should be in_progress"

echo "  ═══ Step 7: Sling a bead (atomic) ═══"
api_post "/api/rigs/${RIG_ID}/sling" '{"title":"Urgent hotfix"}'
assert_status "201" "sling"
SLUNG_BEAD=$(echo "$HTTP_BODY" | jq -r '.data.bead.id')
SLUNG_AGENT=$(echo "$HTTP_BODY" | jq -r '.data.agent.id')
echo "  Slung bead=${SLUNG_BEAD} → agent=${SLUNG_AGENT}"

echo "  ═══ Step 8: Send mail between agents ═══"
api_post "/api/rigs/${RIG_ID}/mail" "$(jq -n --arg from "$AGENT_ID" --arg to "$SLUNG_AGENT" \
  '{from_agent_id: $from, to_agent_id: $to, subject: "coordination", body: "Can you check sidebar?"}')"
assert_status "201" "send mail"

echo "  ═══ Step 9: Check events were generated ═══"
api_get "/api/rigs/${RIG_ID}/events"
assert_status "200" "get events"
EVENT_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
echo "  Events generated: ${EVENT_COUNT}"
if [[ "$EVENT_COUNT" -lt 3 ]]; then
  echo "  FAIL: expected at least 3 events (create, hook, sling)"
  exit 1
fi

echo "  ═══ Step 10: Send mayor message → container ═══"
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"What is the status of our project?"}'
assert_status "200" "send mayor message"
MAYOR_AGENT=$(echo "$HTTP_BODY" | jq -r '.data.agentId')
echo "  Mayor agent: ${MAYOR_AGENT}"

# Wait for container start
sleep 8

echo "  ═══ Step 11: Verify container started ═══"
# Find the most recently created container
CONTAINER_ID=$(docker ps -q --latest 2>/dev/null | head -1)
CONTAINER_COUNT=$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')
echo "  Running containers: ${CONTAINER_COUNT}, latest: ${CONTAINER_ID:-none}"
if [[ "$CONTAINER_COUNT" -lt 1 ]]; then
  echo "  WARNING: No container running — may be expected in some environments"
fi

echo "  ═══ Step 12: Verify mayor status ═══"
api_get "/api/towns/${TOWN_ID}/mayor/status"
assert_status "200" "mayor status"
assert_json_exists "$HTTP_BODY" ".data.session" "mayor should have a session"
assert_json "$HTTP_BODY" ".data.session.agentId" "$MAYOR_AGENT" "mayor agent id"
echo "  Mayor session active"

echo "  ═══ Step 13: Verify container received token ═══"
# Search ALL running containers for the KILO_CONFIG_CONTENT log
# (since we can't easily determine which container belongs to this town)
FOUND_TOKEN=false
for cid in $(docker ps -q 2>/dev/null); do
  if docker logs "$cid" 2>&1 | grep -q "KILO_CONFIG_CONTENT set"; then
    echo "  ✓ Container ${cid} has KILO_CONFIG_CONTENT"
    FOUND_TOKEN=true
    break
  fi
done

if [[ "$FOUND_TOKEN" != "true" ]]; then
  echo "  ✗ No container found with KILO_CONFIG_CONTENT set"
  echo "  Checking all container logs for clues..."
  for cid in $(docker ps -q 2>/dev/null); do
    echo "  --- Container $cid ---"
    docker logs "$cid" 2>&1 | grep -i "kilo\|token\|config\|buildAgentEnv" || echo "  (no relevant logs)"
  done
  exit 1
fi

echo "  ═══ Step 14: List all agents in the rig ═══"
api_get "/api/rigs/${RIG_ID}/agents"
assert_status "200" "list agents"
TOTAL_AGENTS=$(echo "$HTTP_BODY" | jq '.data | length')
echo "  Total agents: ${TOTAL_AGENTS}"
if [[ "$TOTAL_AGENTS" -lt 2 ]]; then
  echo "  FAIL: expected at least 2 agents (registered + slung)"
  exit 1
fi

echo "  ═══ Step 15: Town events feed ═══"
api_get "/api/users/${USER_ID}/towns/${TOWN_ID}/events"
assert_status "200" "town events"
TOWN_EVENTS=$(echo "$HTTP_BODY" | jq '.data | length')
echo "  Town events: ${TOWN_EVENTS}"

echo ""
echo "  ═══════════════════════════════════════════"
echo "  FULL E2E FLOW: ALL 15 STEPS PASSED"
echo "  ═══════════════════════════════════════════"
