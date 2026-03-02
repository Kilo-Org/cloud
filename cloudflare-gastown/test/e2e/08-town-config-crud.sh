#!/usr/bin/env bash
# Test 8: Town config get/update
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)

echo "  Creating town..."
api_post "/api/users/${USER_ID}/towns" '{"name":"Config-Town"}'
assert_status "201" "create town"
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Getting default config..."
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "get config"
assert_json "$HTTP_BODY" ".success" "true" "config response success"

echo "  Updating config with env vars and model..."
api_call PATCH "/api/towns/${TOWN_ID}/config" '{"env_vars":{"MY_VAR":"hello"},"default_model":"anthropic/claude-opus-4.6"}'
assert_status "200" "update config"
assert_json "$HTTP_BODY" ".data.env_vars.MY_VAR" "hello" "env var should be set"
assert_json "$HTTP_BODY" ".data.default_model" "anthropic/claude-opus-4.6" "model should be set"

echo "  Verifying config persisted..."
api_get "/api/towns/${TOWN_ID}/config"
assert_status "200" "re-get config"
assert_json "$HTTP_BODY" ".data.env_vars.MY_VAR" "hello" "env var should persist"
assert_json "$HTTP_BODY" ".data.default_model" "anthropic/claude-opus-4.6" "model should persist"

echo "  Town config CRUD OK"
