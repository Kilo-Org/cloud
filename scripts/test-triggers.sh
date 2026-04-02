#!/bin/bash
# Test script for Webhooks / Triggers feature
# Usage: bash test-triggers.sh <suite> [test-number]
#
# Examples:
#   bash test-triggers.sh kiloclaw        # run all kiloclaw tests
#   bash test-triggers.sh kiloclaw 5      # run only kiloclaw test 5 (F1 standings)
#   bash test-triggers.sh webhook 1       # run only webhook test 1
#   bash test-triggers.sh all             # run all suites
#
# Prerequisites:
#   - Next.js dev server running (pnpm dev) on localhost:3000
#   - Webhook worker running (wrangler dev) on localhost:8793
#
# Environment variables (set before running or edit defaults below):
#   WEBHOOK_URL     - Inbound URL for a webhook trigger
#   KILOCLAW_URL    - Inbound URL for a KiloClaw Chat trigger
#   AUTH_HEADER     - Webhook auth header name (if auth is enabled)
#   AUTH_SECRET     - Webhook auth secret value (if auth is enabled)

# ---------- Defaults (edit these for your local setup) ----------

WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:8793/inbound/user/YOUR_USER_ID/YOUR_TRIGGER_ID}"
KILOCLAW_URL="${KILOCLAW_URL:-http://localhost:8793/inbound/user/8c7eae3a-1893-47ac-93d6-3c6b8886c909/claw-4c86228ddf1545c39f5e8b99b17659eb}"
AUTH_HEADER="${AUTH_HEADER:-x-webhook-secret}"
AUTH_SECRET="${AUTH_SECRET:-}"
NEXTJS_URL="${NEXTJS_URL:-http://localhost:3000}"

SUITE="${1:-help}"
TEST_NUM="${2:-}"

# ---------- Helpers ----------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; }
fail() { echo -e "${RED}FAIL${NC}: $1"; }
info() { echo -e "${YELLOW}INFO${NC}: $1"; }

check_status() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$description (HTTP $actual)"
  else
    fail "$description (expected $expected, got $actual)"
  fi
}

# Returns 0 (true) if we should run this test number
should_run() {
  [ -z "$TEST_NUM" ] || [ "$TEST_NUM" = "$1" ]
}

# ---------- Tests ----------

case "$SUITE" in

  # ====================================================================
  # Redirect tests (Next.js must be running)
  # ====================================================================
  redirects)
    echo "=== Redirect Tests (Next.js at $NEXTJS_URL) ==="
    echo ""

    should_run 1 && {
      status=$(curl -s -o /dev/null -w "%{http_code}" "$NEXTJS_URL/cloud/webhooks")
      check_status "1. /cloud/webhooks redirects" "307" "$status"
    }

    should_run 2 && {
      status=$(curl -s -o /dev/null -w "%{http_code}" "$NEXTJS_URL/cloud/webhooks/new")
      check_status "2. /cloud/webhooks/new redirects" "307" "$status"
    }

    should_run 3 && {
      status=$(curl -s -o /dev/null -w "%{http_code}" "$NEXTJS_URL/cloud/webhooks/test-trigger")
      check_status "3. /cloud/webhooks/<id> redirects" "307" "$status"
    }

    should_run 4 && {
      status=$(curl -s -o /dev/null -w "%{http_code}" "$NEXTJS_URL/cloud/triggers")
      info "4. /cloud/triggers returns HTTP $status (200 or 307 to login expected)"
    }
    ;;

  # ====================================================================
  # Webhook inbound tests (worker must be running)
  # ====================================================================
  webhook)
    echo "=== Webhook Inbound Tests ==="
    echo "URL: $WEBHOOK_URL"
    echo ""

    should_run 1 && {
      echo "--- 1. Valid JSON POST ---"
      curl -s -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        ${AUTH_SECRET:+-H "$AUTH_HEADER: $AUTH_SECRET"} \
        -d '{"event": "test", "message": "Hello from trigger test script"}' | python3 -m json.tool
      echo ""
    }

    should_run 2 && {
      echo "--- 2. GET request (should still capture) ---"
      curl -s -X GET "$WEBHOOK_URL" \
        ${AUTH_SECRET:+-H "$AUTH_HEADER: $AUTH_SECRET"} | python3 -m json.tool
      echo ""
    }

    should_run 3 && {
      echo "--- 3. Empty body ---"
      curl -s -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        ${AUTH_SECRET:+-H "$AUTH_HEADER: $AUTH_SECRET"} \
        -d '' | python3 -m json.tool
      echo ""
    }

    should_run 4 && {
      echo "--- 4. POST with query params ---"
      curl -s -X POST "$WEBHOOK_URL?source=test-script&run=1" \
        -H "Content-Type: application/json" \
        ${AUTH_SECRET:+-H "$AUTH_HEADER: $AUTH_SECRET"} \
        -d '{"test": "query-params"}' | python3 -m json.tool
      echo ""
    }
    ;;

  # ====================================================================
  # Webhook auth tests (requires trigger with auth enabled)
  # ====================================================================
  auth)
    echo "=== Webhook Auth Tests ==="
    echo "URL: $WEBHOOK_URL"
    echo ""

    if [ -z "$AUTH_SECRET" ]; then
      info "AUTH_SECRET not set. Set it to test auth: AUTH_SECRET=mysecret bash test-triggers.sh auth"
      exit 1
    fi

    should_run 1 && {
      echo "--- 1. Valid auth header ---"
      status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -H "$AUTH_HEADER: $AUTH_SECRET" \
        -d '{"test": "auth-valid"}')
      check_status "Valid auth accepted" "200" "$status"
    }

    should_run 2 && {
      echo "--- 2. Missing auth header ---"
      status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d '{"test": "auth-missing"}')
      check_status "Missing auth rejected" "401" "$status"
    }

    should_run 3 && {
      echo "--- 3. Wrong secret ---"
      status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -H "$AUTH_HEADER: wrong-secret-value" \
        -d '{"test": "auth-wrong"}')
      check_status "Wrong secret rejected" "401" "$status"
    }

    should_run 4 && {
      echo "--- 4. Wrong header name ---"
      status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -H "x-wrong-header: $AUTH_SECRET" \
        -d '{"test": "auth-wrong-header"}')
      check_status "Wrong header rejected" "401" "$status"
    }
    ;;

  # ====================================================================
  # KiloClaw Chat webhook tests
  # ====================================================================
  kiloclaw)
    echo "=== KiloClaw Chat Tests ==="
    echo "URL: $KILOCLAW_URL"
    echo ""

    should_run 1 && {
      echo "--- 1. GitHub Push Event ---"
      curl -s -X POST "$KILOCLAW_URL" \
        -H "Content-Type: application/json" \
        -d '{
          "action": "push",
          "ref": "refs/heads/main",
          "repository": {"full_name": "Kilo-Org/cloud"},
          "commits": [
            {"message": "feat: add scheduled triggers", "author": {"name": "astorms"}}
          ],
          "pusher": {"name": "astorms"}
        }' | python3 -m json.tool
      echo ""
    }

    should_run 2 && {
      echo "--- 2. Simple message ---"
      curl -s -X POST "$KILOCLAW_URL" \
        -H "Content-Type: application/json" \
        -d '{"message": "Hello from KiloClaw webhook test!"}' | python3 -m json.tool
      echo ""
    }

    should_run 3 && {
      echo "--- 3. Alert payload ---"
      curl -s -X POST "$KILOCLAW_URL" \
        -H "Content-Type: application/json" \
        -d '{
          "type": "alert",
          "severity": "critical",
          "service": "database",
          "message": "Connection pool exhausted — 0 available connections"
        }' | python3 -m json.tool
      echo ""
    }

    should_run 4 && {
      echo "--- 4. GitHub Issue Opened ---"
      curl -s -X POST "$KILOCLAW_URL" \
        -H "Content-Type: application/json" \
        -d '{
          "action": "opened",
          "issue": {
            "title": "Bug: webhook messages not appearing in chat",
            "body": "Steps to reproduce:\n1. Enable webhook\n2. Send POST\n3. Check chat - nothing appears",
            "number": 42,
            "html_url": "https://github.com/Kilo-Org/cloud/issues/42",
            "labels": [{"name": "bug"}, {"name": "kiloclaw"}]
          },
          "repository": {"full_name": "Kilo-Org/cloud"},
          "sender": {"login": "astorms"}
        }' | python3 -m json.tool
      echo ""
    }

    should_run 5 && {
      echo "--- 5. F1 Standings (fun - makes the bot do real work) ---"
      curl -s -X POST "$KILOCLAW_URL" \
        -H "Content-Type: application/json" \
        -d '{"task": "Get the current 2026 Formula 1 driver championship standings. Show the top 10 drivers with their points, team, and number of wins this season."}' | python3 -m json.tool
      echo ""
    }

    should_run 6 && {
      echo "--- 6. Form Submission ---"
      curl -s -X POST "$KILOCLAW_URL?source=landing-page&campaign=spring2026" \
        -H "Content-Type: application/json" \
        -H "X-Form-Id: contact-us" \
        -d '{
          "form": "contact-us",
          "fields": {
            "name": "Jane Doe",
            "company": "Acme Corp",
            "message": "Interested in KiloClaw for our team. Can we schedule a demo?"
          },
          "submitted_at": "2026-04-01T10:15:00Z"
        }' | python3 -m json.tool
      echo ""
    }
    ;;

  # ====================================================================
  # Validation tests (worker must be running)
  # ====================================================================
  validation)
    echo "=== Validation Tests ==="
    echo ""

    should_run 1 && {
      echo "--- 1. Inactive trigger returns 404 ---"
      info "Create a trigger, deactivate it in the UI, then test its URL"
      echo ""
    }

    should_run 2 && {
      echo "--- 2. Oversized payload (>256KB) ---"
      BIGPAYLOAD=$(python3 -c "print('{\"data\":\"' + 'x' * 300000 + '\"}')")
      status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        ${AUTH_SECRET:+-H "$AUTH_HEADER: $AUTH_SECRET"} \
        -d "$BIGPAYLOAD")
      check_status "Oversized payload rejected" "413" "$status"
    }

    should_run 3 && {
      echo "--- 3. Non-existent trigger ---"
      status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        "http://localhost:8793/inbound/user/fake-user/fake-trigger" \
        -H "Content-Type: application/json" \
        -d '{"test": "nonexistent"}')
      check_status "Non-existent trigger returns 404" "404" "$status"
    }
    ;;

  # ====================================================================
  # Run all test suites
  # ====================================================================
  all)
    echo "========================================="
    echo "  Running all trigger test suites"
    echo "========================================="
    echo ""
    bash "$0" redirects
    echo ""
    bash "$0" webhook
    echo ""
    bash "$0" kiloclaw
    echo ""
    bash "$0" validation
    ;;

  # ====================================================================
  # Help
  # ====================================================================
  *)
    echo "Webhooks / Triggers Test Script"
    echo ""
    echo "Usage: bash test-triggers.sh <suite> [test-number]"
    echo ""
    echo "Test suites:"
    echo "  redirects    Test /cloud/webhooks -> /cloud/triggers redirects (needs Next.js)"
    echo "  webhook      Send test payloads to a webhook trigger (needs worker)"
    echo "  auth         Test webhook auth accept/reject (needs worker + AUTH_SECRET)"
    echo "  kiloclaw     Send test payloads to a KiloClaw Chat trigger (needs worker)"
    echo "  validation   Test edge cases: oversized payloads, nonexistent triggers"
    echo "  all          Run all suites"
    echo ""
    echo "Run a single test within a suite:"
    echo "  bash test-triggers.sh kiloclaw 5    # just the F1 standings test"
    echo "  bash test-triggers.sh webhook 1     # just the valid POST test"
    echo ""
    echo "KiloClaw tests:"
    echo "  1  GitHub Push Event"
    echo "  2  Simple message"
    echo "  3  Alert payload"
    echo "  4  GitHub Issue Opened"
    echo "  5  F1 Standings (makes the bot do real work)"
    echo "  6  Form Submission"
    echo ""
    echo "Environment variables:"
    echo "  WEBHOOK_URL   = $WEBHOOK_URL"
    echo "  KILOCLAW_URL  = $KILOCLAW_URL"
    echo "  AUTH_HEADER   = $AUTH_HEADER"
    echo "  AUTH_SECRET   = ${AUTH_SECRET:-(not set)}"
    echo "  NEXTJS_URL    = $NEXTJS_URL"
    echo ""
    echo "Examples:"
    echo "  bash test-triggers.sh kiloclaw 5"
    echo "  bash test-triggers.sh all"
    echo "  WEBHOOK_URL=http://localhost:8793/inbound/user/abc/my-trigger bash test-triggers.sh webhook"
    echo "  AUTH_SECRET=mysecret bash test-triggers.sh auth"
    ;;
esac
