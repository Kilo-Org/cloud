#!/usr/bin/env bash
# Test 15: Send mail between agents and check delivery
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

USER_ID=$(unique_user_id)
api_post "/api/users/${USER_ID}/towns" '{"name":"Mail-Town"}'
TOWN_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')
CURRENT_TOWN_ID="$TOWN_ID"

api_post "/api/users/${USER_ID}/rigs" "$(jq -n --arg t "$TOWN_ID" '{town_id: $t, name: "mail-rig", git_url: "https://github.com/t/r.git", default_branch: "main"}')"
RIG_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents" '{"role":"polecat","name":"Sender","identity":"sender-1"}'
SENDER_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

api_post "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents" '{"role":"polecat","name":"Receiver","identity":"receiver-1"}'
RECEIVER_ID=$(echo "$HTTP_BODY" | jq -r '.data.id')

echo "  Sending mail..."
api_post "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/mail" "$(jq -n --arg from "$SENDER_ID" --arg to "$RECEIVER_ID" \
  '{from_agent_id: $from, to_agent_id: $to, subject: "test", body: "hello"}')"
assert_status "201" "send mail"

echo "  Checking mail for receiver..."
api_get "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents/${RECEIVER_ID}/mail"
assert_status "200" "check mail"
MAIL_COUNT=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$MAIL_COUNT" "1" "should have 1 mail"
assert_json "$HTTP_BODY" ".data[0].subject" "test" "mail subject"

echo "  Checking mail again (should be empty — already delivered)..."
api_get "/api/towns/${TOWN_ID}/rigs/${RIG_ID}/agents/${RECEIVER_ID}/mail"
assert_status "200" "check mail again"
MAIL_COUNT2=$(echo "$HTTP_BODY" | jq '.data | length')
assert_eq "$MAIL_COUNT2" "0" "should have 0 mail (already delivered)"

echo "  Mail OK"
