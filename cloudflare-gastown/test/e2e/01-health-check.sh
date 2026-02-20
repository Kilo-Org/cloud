#!/usr/bin/env bash
# Test 1: Health check — wrangler responds on the expected port
set -euo pipefail
source "$(dirname "$0")/helpers.sh"

echo "  Checking worker health endpoint..."
api_get "/health"
assert_status "200" "GET /health should return 200"
assert_json "$HTTP_BODY" ".status" "ok" "health status should be ok"

echo "  Checking 404 for unknown route..."
api_get "/nonexistent"
assert_status "404" "Unknown route should return 404"

echo "  Health OK"
