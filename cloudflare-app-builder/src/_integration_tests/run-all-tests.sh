#!/bin/bash

# Run all App Builder integration tests
# Usage: ./run-all-tests.sh
#
# Prerequisites:
# - App builder running at http://localhost:8790
# - AUTH_TOKEN environment variable set (or uses default)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../.."

# Default values
export APP_BUILDER_URL="${APP_BUILDER_URL:-http://localhost:8790}"
export AUTH_TOKEN="${AUTH_TOKEN:-dev-token-change-this-in-production}"

echo "========================================"
echo "App Builder Integration Tests"
echo "========================================"
echo "URL: $APP_BUILDER_URL"
echo "Running from: $(pwd)"
echo "========================================"
echo ""

TOTAL_PASSED=0
TOTAL_FAILED=0
FAILED_TESTS=()

run_test() {
  local test_name="$1"
  local test_file="$2"

  echo ""
  echo "========================================"
  echo "Running: $test_name"
  echo "========================================"
  echo ""

  if pnpm exec tsx "$test_file"; then
    TOTAL_PASSED=$((TOTAL_PASSED + 1))
  else
    TOTAL_FAILED=$((TOTAL_FAILED + 1))
    FAILED_TESTS+=("$test_name")
  fi
}

# Run all test suites
run_test "Basic Git Integration" "src/_integration_tests/test-git-integration.ts"
run_test "Authentication Edge Cases" "src/_integration_tests/test-auth-edge-cases.ts"
run_test "Init Edge Cases" "src/_integration_tests/test-init-edge-cases.ts"
run_test "Files API" "src/_integration_tests/test-files-api.ts"
run_test "Delete Endpoint" "src/_integration_tests/test-delete.ts"
run_test "Advanced Git Operations" "src/_integration_tests/test-git-advanced.ts"

# Final summary
echo ""
echo "========================================"
echo "FINAL SUMMARY"
echo "========================================"
echo "Test suites passed: $TOTAL_PASSED"
echo "Test suites failed: $TOTAL_FAILED"

if [ $TOTAL_FAILED -gt 0 ]; then
  echo ""
  echo "Failed test suites:"
  for test in "${FAILED_TESTS[@]}"; do
    echo "  - $test"
  done
  echo ""
  echo "❌ SOME TEST SUITES FAILED"
  exit 1
else
  echo ""
  echo "🎉 ALL TEST SUITES PASSED!"
  exit 0
fi
