#!/usr/bin/env bash
# Test 29: Trace token flow through the ACTUAL Next.js tRPC → gastown worker path
# This test logs into the Next.js server as a fake user and creates a town+rig
# through the tRPC API, then checks if the token arrived in the gastown worker.
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

NEXTJS_URL="http://localhost:3000"
WRANGLER_URL="http://localhost:8787"

echo "  ═══ Pre-check ═══"
NEXTJS_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "${NEXTJS_URL}/" 2>/dev/null || echo "0")
WRANGLER_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "${WRANGLER_URL}/health" 2>/dev/null || echo "0")
echo "  Next.js (3000): ${NEXTJS_STATUS}"
echo "  Wrangler (8787): ${WRANGLER_STATUS}"

if [[ "$NEXTJS_STATUS" == "0" || "$WRANGLER_STATUS" == "0" ]]; then
  echo "  Both servers must be running. Skipping."
  exit 0
fi

echo "  ═══ Step 1: Login as fake user via Next.js ═══"
FAKE_EMAIL="kilo-e2etest-$(date +%H%M%S)@example.com"
echo "  Fake email: ${FAKE_EMAIL}"

# Get the session cookie by visiting the fake login URL
# Follow redirects and save cookies
COOKIE_JAR=$(mktemp)
LOGIN_RESP=$(curl -sf -c "$COOKIE_JAR" -L -o /dev/null -w '%{http_code}' \
  "${NEXTJS_URL}/users/sign_in?fakeUser=${FAKE_EMAIL}" 2>/dev/null || echo "0")
echo "  Login response: ${LOGIN_RESP}"

# Wait for account creation
sleep 3

# Check if we got a session cookie
SESSION_COOKIE=$(grep -i "session\|next-auth\|token" "$COOKIE_JAR" 2>/dev/null | head -1 || echo "")
echo "  Session cookie: ${SESSION_COOKIE:0:80}..."

if [[ -z "$SESSION_COOKIE" ]]; then
  echo "  No session cookie obtained. Checking cookie jar:"
  cat "$COOKIE_JAR" | head -10
  echo ""
  echo "  Trying tRPC call anyway..."
fi

echo "  ═══ Step 2: Create town via tRPC ═══"
# tRPC batch mutation format
TRPC_CREATE_TOWN=$(curl -sf -b "$COOKIE_JAR" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"0":{"json":{"name":"TRPC-Token-Town"}}}' \
  "${NEXTJS_URL}/api/trpc/gastown.createTown?batch=1" 2>/dev/null || echo "{}")
echo "  tRPC createTown response: ${TRPC_CREATE_TOWN:0:200}"

TOWN_ID=$(echo "$TRPC_CREATE_TOWN" | jq -r '.[0].result.data.json.id // "NONE"' 2>/dev/null || echo "NONE")
if [[ "$TOWN_ID" == "NONE" || "$TOWN_ID" == "null" || -z "$TOWN_ID" ]]; then
  echo "  Failed to create town via tRPC. Response: ${TRPC_CREATE_TOWN:0:500}"
  echo "  This may be an auth issue — fake user login may not work via curl."
  echo ""
  echo "  ═══ Fallback: Test token flow via direct API ═══"
  # Create directly on the test wrangler to verify the worker-side flow works
  FALLBACK_URL="${BASE_URL}"
  USER_ID="trpc-fallback-$(date +%s)-${RANDOM}"
  TOKEN="trpc-test-token-$(date +%s)"
  
  TOWN_BODY=$(curl -sf -X POST -H 'Content-Type: application/json' \
    -d '{"name":"Direct-Token-Town"}' \
    "${FALLBACK_URL}/api/users/${USER_ID}/towns")
  TOWN_ID=$(echo "$TOWN_BODY" | jq -r '.data.id')
  echo "  Direct town: ${TOWN_ID}"
  
  RIG_BODY=$(curl -sf -X POST -H 'Content-Type: application/json' \
    -d "{\"town_id\":\"${TOWN_ID}\",\"name\":\"direct-rig\",\"git_url\":\"https://github.com/t/r.git\",\"default_branch\":\"main\",\"kilocode_token\":\"${TOKEN}\"}" \
    "${FALLBACK_URL}/api/users/${USER_ID}/rigs")
  echo "  Direct rig: $(echo "$RIG_BODY" | jq -r '.data.id')"
  
  CONFIG=$(curl -sf "${FALLBACK_URL}/api/towns/${TOWN_ID}/config")
  CONFIG_TOKEN=$(echo "$CONFIG" | jq -r '.data.kilocode_token // "NONE"')
  echo "  Direct config token: ${CONFIG_TOKEN}"
  
  if [[ "$CONFIG_TOKEN" == "$TOKEN" ]]; then
    echo ""
    echo "  ✓ Direct API token flow works on port 8787"
    echo "  The issue is likely in how the UI/tRPC creates the rig."
    echo "  Check the Next.js console for these logs:"
    echo "    [gastown-router] createRig: generating kilocodeToken for user=..."
    echo "    [gastown-client] POST /api/users/.../rigs bodyKeys=[...,kilocode_token]"
    echo "  And the wrangler console for:"
    echo "    [towns.handler] handleCreateRig: ... hasKilocodeToken=true"
  else
    echo "  ✗ Direct API token flow FAILED on port 8787"
  fi

  rm -f "$COOKIE_JAR"
  exit 0
fi

echo "  Town: ${TOWN_ID}"

echo "  ═══ Step 3: Create rig via tRPC (with auto-generated token) ═══"
TRPC_CREATE_RIG=$(curl -sf -b "$COOKIE_JAR" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"0\":{\"json\":{\"townId\":\"${TOWN_ID}\",\"name\":\"trpc-rig\",\"gitUrl\":\"https://github.com/test/repo.git\",\"defaultBranch\":\"main\"}}}" \
  "${NEXTJS_URL}/api/trpc/gastown.createRig?batch=1" 2>/dev/null || echo "{}")
echo "  tRPC createRig response: ${TRPC_CREATE_RIG:0:200}"

echo "  ═══ Step 4: Check town config on wrangler for token ═══"
sleep 1
CONFIG=$(curl -sf "${WRANGLER_URL}/api/towns/${TOWN_ID}/config")
CONFIG_TOKEN=$(echo "$CONFIG" | jq -r '.data.kilocode_token // "NONE"')
echo "  Town config kilocode_token: ${CONFIG_TOKEN}"

if [[ "$CONFIG_TOKEN" != "NONE" && -n "$CONFIG_TOKEN" ]]; then
  echo "  ✓ Token propagated through tRPC → gastown-client → worker → TownDO"
else
  echo "  ✗ Token NOT propagated through tRPC path"
  echo "  This confirms the issue is in the tRPC → gastown-client → worker chain"
fi

rm -f "$COOKIE_JAR"
echo "  tRPC token trace done"
