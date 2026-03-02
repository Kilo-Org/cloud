#!/usr/bin/env bash
# Test 27: Check the user's wrangler instance on port 8787
# This test does NOT start its own wrangler — it tests the EXISTING one
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

# Override base URL to point at the user's wrangler
USER_WRANGLER_URL="http://localhost:8787"

echo "  ═══ Check if user's wrangler is running on 8787 ═══"
HTTP_STATUS=""
HTTP_BODY=""
_E2E_BODY_FILE_27=$(mktemp)
HTTP_STATUS=$(curl -s -o "$_E2E_BODY_FILE_27" -w '%{http_code}' -X GET -H 'Content-Type: application/json' "${USER_WRANGLER_URL}/health" 2>/dev/null || echo "0")
HTTP_BODY=$(cat "$_E2E_BODY_FILE_27")
rm -f "$_E2E_BODY_FILE_27"

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "  User's wrangler not running on port 8787 (status=${HTTP_STATUS})"
  echo "  This test only runs when the user has wrangler dev on 8787"
  exit 0
fi
echo "  User's wrangler is running: ${HTTP_BODY}"

echo "  ═══ Create town + rig on user's wrangler ═══"
USER_ID="e2e-check-8787-$(date +%s)-${RANDOM}"

# Create town
_E2E_BODY_FILE_27=$(mktemp)
HTTP_STATUS=$(curl -s -o "$_E2E_BODY_FILE_27" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"name":"Check-8787-Town"}' \
  "${USER_WRANGLER_URL}/api/users/${USER_ID}/towns" 2>/dev/null)
HTTP_BODY=$(cat "$_E2E_BODY_FILE_27")
rm -f "$_E2E_BODY_FILE_27"
echo "  Create town: status=${HTTP_STATUS}"

if [[ "$HTTP_STATUS" != "201" ]]; then
  echo "  FAIL: Could not create town on user's wrangler: ${HTTP_BODY}"
  exit 1
fi
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
echo "  Town: ${TOWN_ID}"

# Create rig with token
KNOWN_TOKEN="e2e-8787-token-$(date +%s)"
RIG_PAYLOAD=$(jq -n \
  --arg town_id "$TOWN_ID" \
  --arg name "check-rig" \
  --arg git_url "https://github.com/test/repo.git" \
  --arg kilocode_token "$KNOWN_TOKEN" \
  '{town_id: $town_id, name: $name, git_url: $git_url, default_branch: "main", kilocode_token: $kilocode_token}')

_E2E_BODY_FILE_27=$(mktemp)
HTTP_STATUS=$(curl -s -o "$_E2E_BODY_FILE_27" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d "$RIG_PAYLOAD" \
  "${USER_WRANGLER_URL}/api/users/${USER_ID}/rigs" 2>/dev/null)
HTTP_BODY=$(cat "$_E2E_BODY_FILE_27")
rm -f "$_E2E_BODY_FILE_27"
echo "  Create rig: status=${HTTP_STATUS}"

if [[ "$HTTP_STATUS" != "201" ]]; then
  echo "  FAIL: Could not create rig: ${HTTP_BODY}"
  exit 1
fi

# Check town config for token
_E2E_BODY_FILE_27=$(mktemp)
HTTP_STATUS=$(curl -s -o "$_E2E_BODY_FILE_27" -w '%{http_code}' -X GET -H 'Content-Type: application/json' \
  "${USER_WRANGLER_URL}/api/towns/${TOWN_ID}/config" 2>/dev/null)
HTTP_BODY=$(cat "$_E2E_BODY_FILE_27")
rm -f "$_E2E_BODY_FILE_27"

TOKEN_RESULT=$(echo "$HTTP_BODY" | jq -r '.data.kilocode_token // "NONE"')
echo ""
echo "  ═══ Result ═══"
echo "  Town config kilocode_token on port 8787: ${TOKEN_RESULT}"
echo "  Expected: ${KNOWN_TOKEN}"

if [[ "$TOKEN_RESULT" == "$KNOWN_TOKEN" ]]; then
  echo "  ✓ Token propagation works on user's wrangler (port 8787)"
else
  echo "  ✗ Token NOT propagated on user's wrangler!"
  echo "  Full town config: ${HTTP_BODY}"
  echo ""
  echo "  This means the user's wrangler is running code that does NOT"
  echo "  propagate kilocode_token from configureRig to town config."
  echo "  The user needs to restart their wrangler dev process."
  exit 1
fi
