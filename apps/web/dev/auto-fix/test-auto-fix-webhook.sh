#!/usr/bin/env bash
set -euo pipefail

# Intentionally generic test payload.
# Ask an AI to replace with a real webhook payload captured from smee.io.

WEBHOOK_URL="${WEBHOOK_URL:-http://127.0.0.1:3000/api/webhooks/github}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-dausigdb781g287d9asgd9721dsa}"
EVENT_TYPE="${EVENT_TYPE:-}"
DEFAULT_EVENT_TYPE="pull_request_review_comment"
DELIVERY_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"

# Optional first arg: path to JSON file containing a real GitHub webhook body.
PAYLOAD_FILE="${1:-}"

GENERIC_BODY='{
  "action": "created",
  "comment": {
    "id": 987654321,
    "body": "@kilo fix it",
    "user": {
      "login": "octocat"
    },
    "html_url": "https://github.com/OWNER/REPO/pull/123#discussion_r987654321",
    "path": "src/example.ts",
    "line": 42,
    "diff_hunk": "@@ -1,1 +1,1 @@\\n-const bad = true;\\n+const good = true;",
    "author_association": "OWNER"
  },
  "pull_request": {
    "number": 123,
    "title": "PLACEHOLDER: Replace with real PR title",
    "html_url": "https://github.com/OWNER/REPO/pull/123",
    "user": {
      "login": "octocat"
    },
    "head": {
      "sha": "1111111111111111111111111111111111111111",
      "ref": "feature/placeholder"
    },
    "base": {
      "ref": "main"
    }
  },
  "repository": {
    "id": 1,
    "name": "REPO",
    "full_name": "OWNER/REPO",
    "private": false,
    "owner": {
      "login": "OWNER"
    }
  },
  "installation": {
    "id": 12345678
  },
  "sender": {
    "login": "octocat"
  }
}'

if [ "$PAYLOAD_FILE" = "-" ]; then
  RAW_BODY="$(cat)"
  PAYLOAD_SOURCE="stdin"
elif [ -n "$PAYLOAD_FILE" ]; then
  RAW_BODY="$(cat "$PAYLOAD_FILE")"
  PAYLOAD_SOURCE="$PAYLOAD_FILE"
else
  RAW_BODY="$GENERIC_BODY"
  PAYLOAD_SOURCE="embedded generic payload"
fi

# Prefer explicit EVENT_TYPE env var, otherwise infer from wrapped payload .event.
DETECTED_EVENT="$(printf '%s' "$RAW_BODY" | jq -r 'if (type == "object" and has("event") and (.event | type == "string")) then .event else empty end')"
if [ -n "$EVENT_TYPE" ]; then
  FINAL_EVENT_TYPE="$EVENT_TYPE"
elif [ -n "$DETECTED_EVENT" ]; then
  FINAL_EVENT_TYPE="$DETECTED_EVENT"
else
  FINAL_EVENT_TYPE="$DEFAULT_EVENT_TYPE"
fi

# Support envelope payloads like {"event":"...","payload":{...}}.
BODY="$(printf '%s' "$RAW_BODY" | jq -c 'if (type == "object" and has("payload")) then .payload else . end')"

SIGNATURE="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"

echo "Delivery ID:   $DELIVERY_ID"
echo "Event:         $FINAL_EVENT_TYPE"
echo "URL:           $WEBHOOK_URL"
echo "Payload source:$PAYLOAD_SOURCE"
echo "Signature:     $SIGNATURE"
echo
echo "Sending webhook..."
echo

curl -s -w "\nHTTP Status: %{http_code}\n" -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "x-github-event: $FINAL_EVENT_TYPE" \
  -H "x-github-delivery: $DELIVERY_ID" \
  -H "x-hub-signature-256: $SIGNATURE" \
  -d "$BODY"

echo
echo "Done."
