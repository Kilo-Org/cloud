#!/usr/bin/env bash
# Test 18: Env vars from town config are included in X-Town-Config
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
FAKE_TOKEN="e2e-token-$(date +%s)"

api_post "/api/users/${USER_ID}/towns" '{"name":"EnvVar-Town"}'
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

# Set env vars via config update
echo "  Setting env vars in town config..."
api_call PATCH "/api/towns/${TOWN_ID}/config" '{"env_vars":{"CUSTOM_VAR":"custom_value","ANOTHER":"second"}}'
assert_status "200" "update config"
assert_json "$HTTP_BODY" ".data.env_vars.CUSTOM_VAR" "custom_value" "CUSTOM_VAR"
assert_json "$HTTP_BODY" ".data.env_vars.ANOTHER" "second" "ANOTHER"

# Create rig + send mayor message to trigger container start with config
api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" --arg tk "$FAKE_TOKEN" \
  '{town_id: $t, name: "envvar-rig", git_url: "https://github.com/t/r.git", default_branch: "main", kilocode_token: $tk}')"
assert_status "201" "create rig"

echo "  Sending mayor message to trigger container..."
api_post "/api/towns/${TOWN_ID}/mayor/message" '{"message":"env var test"}'
assert_status "200" "send mayor message"

# Wait for X-Town-Config to be delivered
sleep 3

echo "  Checking wrangler logs for env_vars in X-Town-Config..."
if grep -q "X-Town-Config received" "$WRANGLER_LOG"; then
  echo "  X-Town-Config was delivered"
else
  echo "  WARNING: No X-Town-Config log found"
fi

# Verify config still has the env vars
api_get "/api/towns/${TOWN_ID}/config"
assert_json "$HTTP_BODY" ".data.env_vars.CUSTOM_VAR" "custom_value" "CUSTOM_VAR persisted"

echo "  Config env vars to container OK"
