#!/bin/bash
# Fetch Kilocode CLI logs for a session and save to /tmp/cli.txt
#
# Usage: ./get-session-logs.sh <sessionId>
#
# Environment variables:
#   WORKER_URL      - Worker base URL (e.g., https://your-worker.workers.dev)
#   KILOCODE_TOKEN  - Authentication token

set -e

SESSION_ID="${1:?Usage: $0 <sessionId>}"

: "${WORKER_URL:?WORKER_URL environment variable is required}"
: "${KILOCODE_TOKEN:?KILOCODE_TOKEN environment variable is required}"

# URL-encode the JSON input
INPUT=$(printf '{"sessionId":"%s"}' "$SESSION_ID" | jq -sRr @uri)

# Fetch logs and capture response
RESPONSE=$(curl -s --fail-with-body "${WORKER_URL}/trpc/getSessionLogs?input=${INPUT}" \
  -H "Authorization: Bearer ${KILOCODE_TOKEN}" 2>&1) || {
  echo "Error: Request failed" >&2
  echo "$RESPONSE" >&2
  exit 1
}

# Extract content and write to file
echo "$RESPONSE" | jq -r '.result.data.content'