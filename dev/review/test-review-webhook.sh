#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

usage() {
  cat <<'EOF'
Usage: ./dev/review/test-review-webhook.sh [--github|--gitlab] [payload.json|-]

Environment:
  PLATFORM=github|gitlab              Platform when no flag is provided.
  WEBHOOK_URL=...                     Override target URL.
  WEBHOOK_SECRET=...                  GitHub HMAC secret. Defaults to GITHUB_APP_WEBHOOK_SECRET.
  GITLAB_WEBHOOK_TOKEN=...            GitLab token. Defaults to the local seed token.
  VERIFY_FAKE_LLM=1                   Poll fake-llm /test/prompts for the generated prompt.
  VERIFY_TIMEOUT_SECONDS=180          Fake-LLM verification timeout.

Default payloads are written by:
  pnpm dev:seed review:webhook-fixtures
EOF
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

service_port() {
  local service_name="$1"
  printf '%s' "$DEV_STATUS" | jq -r --arg name "$service_name" '
    [.services[] | select(.name == $name and .status == "up") | .port][0] // empty
  '
}

load_dotenv_value() {
  local key="$1"
  node -e '
const fs = require("node:fs");
const key = process.argv[1];
for (const file of [".env.local", "apps/web/.env.local"]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    let value = match[2].trim();
    if (value.length >= 2 && value.charCodeAt(0) === value.charCodeAt(value.length - 1) && [34, 39].includes(value.charCodeAt(0))) {
      value = value.slice(1, -1);
    }
    process.stdout.write(value);
    process.exit(0);
  }
}
process.exit(1);
' "$key"
}

PLATFORM="${PLATFORM:-github}"
case "${1:-}" in
  --github)
    PLATFORM="github"
    shift
    ;;
  --gitlab)
    PLATFORM="gitlab"
    shift
    ;;
  --help|-h)
    usage
    exit 0
    ;;
esac

if [ "$PLATFORM" != "github" ] && [ "$PLATFORM" != "gitlab" ]; then
  echo "PLATFORM must be github or gitlab" >&2
  exit 1
fi

require_command curl
require_command jq
require_command node
require_command openssl
require_command uuidgen

DEV_STATUS="$(pnpm -s dev:status --json)"
NEXTJS_PORT="$(service_port nextjs)"
if [ -z "$NEXTJS_PORT" ] && [ -z "${WEBHOOK_URL:-}" ]; then
  echo "nextjs is not running. Start the review stack first:" >&2
  echo "  CODE_REVIEW_LOCAL_FAKE_PROVIDER=1 KILO_PORT_OFFSET=auto pnpm dev:start --no-attach code-review" >&2
  echo "Or set WEBHOOK_URL to a running local Next.js webhook endpoint." >&2
  exit 1
fi

FAKE_LLM_PORT=""
FAKE_LLM_BASELINE_REQ_ID="0"
if [ "${VERIFY_FAKE_LLM:-0}" = "1" ]; then
  FAKE_LLM_PORT="$(service_port fake-llm)"
  if [ -z "$FAKE_LLM_PORT" ]; then
    echo "fake-llm is not running; cannot verify generated prompt." >&2
    exit 1
  fi
  BASELINE_PROMPTS="$(curl -fsS "http://127.0.0.1:$FAKE_LLM_PORT/test/prompts" 2>/dev/null || true)"
  if [ -n "$BASELINE_PROMPTS" ]; then
    FAKE_LLM_BASELINE_REQ_ID="$(printf '%s' "$BASELINE_PROMPTS" | jq -r '[.prompts[]?.reqId // 0] | max // 0')"
  fi
fi

DEFAULT_GITHUB_FIXTURE="$REPO_ROOT/dev/review/fixtures/github-pull-request-opened.json"
DEFAULT_GITLAB_FIXTURE="$REPO_ROOT/dev/review/fixtures/gitlab-merge-request-open.json"
PAYLOAD_FILE="${1:-}"

if [ -z "$PAYLOAD_FILE" ]; then
  if [ "$PLATFORM" = "github" ]; then
    PAYLOAD_FILE="$DEFAULT_GITHUB_FIXTURE"
  else
    PAYLOAD_FILE="$DEFAULT_GITLAB_FIXTURE"
  fi
fi

if [ "$PAYLOAD_FILE" = "-" ]; then
  RAW_BODY="$(cat)"
  PAYLOAD_SOURCE="stdin"
elif [ -f "$PAYLOAD_FILE" ]; then
  RAW_BODY="$(cat "$PAYLOAD_FILE")"
  PAYLOAD_SOURCE="$PAYLOAD_FILE"
else
  echo "Payload file not found: $PAYLOAD_FILE" >&2
  echo "Create local fixtures with: pnpm dev:seed review:webhook-fixtures" >&2
  exit 1
fi

BODY="$(printf '%s' "$RAW_BODY" | jq -c 'if (type == "object" and has("payload")) then .payload else . end')"
DELIVERY_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
RESPONSE_FILE="$(mktemp)"
trap 'rm -f "$RESPONSE_FILE"' EXIT

if [ "$PLATFORM" = "github" ]; then
  WEBHOOK_URL="${WEBHOOK_URL:-http://127.0.0.1:$NEXTJS_PORT/api/webhooks/github}"
  DEFAULT_EVENT_TYPE="pull_request"
  DETECTED_EVENT="$(printf '%s' "$RAW_BODY" | jq -r 'if (type == "object" and has("event") and (.event | type == "string")) then .event else empty end')"
  FINAL_EVENT_TYPE="${EVENT_TYPE:-${DETECTED_EVENT:-$DEFAULT_EVENT_TYPE}}"
  WEBHOOK_SECRET="${WEBHOOK_SECRET:-${GITHUB_APP_WEBHOOK_SECRET:-}}"
  if [ -z "$WEBHOOK_SECRET" ]; then
    WEBHOOK_SECRET="$(cd "$REPO_ROOT" && load_dotenv_value GITHUB_APP_WEBHOOK_SECRET || true)"
  fi
  if [ -z "$WEBHOOK_SECRET" ]; then
    echo "Set WEBHOOK_SECRET or GITHUB_APP_WEBHOOK_SECRET for GitHub signature verification." >&2
    exit 1
  fi
  SIGNATURE="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"

  echo "Platform:       github"
  echo "Delivery ID:    $DELIVERY_ID"
  echo "Event:          $FINAL_EVENT_TYPE"
  echo "URL:            $WEBHOOK_URL"
  echo "Payload source: $PAYLOAD_SOURCE"
  echo

  STATUS="$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "x-github-event: $FINAL_EVENT_TYPE" \
    -H "x-github-delivery: $DELIVERY_ID" \
    -H "x-hub-signature-256: $SIGNATURE" \
    -d "$BODY")"
  EXPECTED_PROMPT_TEXT="${EXPECTED_PROMPT_TEXT:-kilo-dev/review-fixture}"
else
  WEBHOOK_URL="${WEBHOOK_URL:-http://127.0.0.1:$NEXTJS_PORT/api/webhooks/gitlab}"
  FINAL_EVENT_TYPE="${EVENT_TYPE:-Merge Request Hook}"
  GITLAB_WEBHOOK_TOKEN="${GITLAB_WEBHOOK_TOKEN:-dev-review-gitlab-webhook-secret}"

  echo "Platform:       gitlab"
  echo "Delivery ID:    $DELIVERY_ID"
  echo "Event:          $FINAL_EVENT_TYPE"
  echo "URL:            $WEBHOOK_URL"
  echo "Payload source: $PAYLOAD_SOURCE"
  echo

  STATUS="$(curl -sS -o "$RESPONSE_FILE" -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "x-gitlab-event: $FINAL_EVENT_TYPE" \
    -H "x-gitlab-event-uuid: $DELIVERY_ID" \
    -H "x-gitlab-token: $GITLAB_WEBHOOK_TOKEN" \
    -d "$BODY")"
  EXPECTED_PROMPT_TEXT="${EXPECTED_PROMPT_TEXT:-kilo-dev/gitlab-review-fixture}"
fi

cat "$RESPONSE_FILE"
echo
echo "HTTP Status: $STATUS"

if [ "$STATUS" -lt 200 ] || [ "$STATUS" -ge 300 ]; then
  exit 1
fi

REVIEW_ID="$(jq -r 'if type == "object" and has("reviewId") then .reviewId else empty end' "$RESPONSE_FILE")"
if [ -n "$REVIEW_ID" ]; then
  echo "Review ID: $REVIEW_ID"
fi

if [ "${VERIFY_FAKE_LLM:-0}" = "1" ]; then
  echo "Waiting for fake-llm to observe generated prompt containing: $EXPECTED_PROMPT_TEXT"
  DEADLINE=$((SECONDS + ${VERIFY_TIMEOUT_SECONDS:-180}))
  while [ "$SECONDS" -lt "$DEADLINE" ]; do
    PROMPTS="$(curl -fsS "http://127.0.0.1:$FAKE_LLM_PORT/test/prompts" 2>/dev/null || true)"
    if [ -n "$PROMPTS" ] && printf '%s' "$PROMPTS" | jq -e \
      --argjson baseline "$FAKE_LLM_BASELINE_REQ_ID" \
      --arg text "$EXPECTED_PROMPT_TEXT" \
      --arg directive "__fake__:idle" \
      'any(.prompts[]?; ((.reqId // 0) > $baseline) and (.text | contains($text)) and (.text | contains($directive)))' >/dev/null; then
      echo "Verified generated review prompt reached fake-llm."
      exit 0
    fi
    sleep 2
  done

  echo "Timed out waiting for fake-llm prompt capture." >&2
  exit 1
fi

echo "Done."
