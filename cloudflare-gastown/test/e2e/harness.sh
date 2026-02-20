#!/usr/bin/env bash
# E2E Test Harness for Gastown
# Starts a real wrangler dev instance, runs tests, cleans up.
# Usage: ./harness.sh [test-file]  (or run all tests if no arg)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
PORT=9787
BASE_URL="http://localhost:${PORT}"
WRANGLER_PID=""
WRANGLER_LOG="${SCRIPT_DIR}/.wrangler-output.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

cleanup() {
  if [[ -n "$WRANGLER_PID" ]] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo -e "${YELLOW}Stopping wrangler (pid=$WRANGLER_PID)...${NC}"
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

start_wrangler() {
  echo -e "${CYAN}Starting wrangler dev on port ${PORT}...${NC}"

  # Clean up any stale wrangler data to get fresh DOs
  rm -rf "${PROJECT_DIR}/.wrangler/state/v3/d1" 2>/dev/null || true

  cd "$PROJECT_DIR"
  npx wrangler dev --env dev --port "$PORT" --inspector-port 0 --local \
    --var "GASTOWN_API_URL:http://host.docker.internal:${PORT}" \
    > "$WRANGLER_LOG" 2>&1 &
  WRANGLER_PID=$!

  echo "  wrangler pid=$WRANGLER_PID, log=$WRANGLER_LOG"

  # Wait for wrangler to be ready (up to 30s)
  local retries=0
  local max_retries=60
  while [[ $retries -lt $max_retries ]]; do
    if curl -sf "${BASE_URL}/health" >/dev/null 2>&1; then
      echo -e "${GREEN}  wrangler ready on port ${PORT}${NC}"
      return 0
    fi
    # Check that wrangler didn't crash
    if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
      echo -e "${RED}  wrangler process died! Log:${NC}"
      tail -30 "$WRANGLER_LOG"
      return 1
    fi
    sleep 0.5
    retries=$((retries + 1))
  done

  echo -e "${RED}  wrangler did not become ready in 30s. Log tail:${NC}"
  tail -30 "$WRANGLER_LOG"
  return 1
}

# ── Test runner ──────────────────────────────────────────────────────

run_test() {
  local test_file="$1"
  local test_name
  test_name=$(basename "$test_file" .sh)

  echo -e "\n${CYAN}━━━ Running: ${test_name} ━━━${NC}"

  if bash "$test_file"; then
    echo -e "${GREEN}  ✓ ${test_name} PASSED${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    echo -e "${RED}  ✗ ${test_name} FAILED${NC}"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
}

# Export env for test files (they source helpers.sh for functions)
export BASE_URL PORT WRANGLER_LOG

# ── Main ─────────────────────────────────────────────────────────────

main() {
  start_wrangler

  if [[ $# -gt 0 ]]; then
    # Run specific test(s)
    for test_file in "$@"; do
      if [[ -f "$test_file" ]]; then
        run_test "$test_file"
      else
        echo -e "${RED}Test file not found: $test_file${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
      fi
    done
  else
    # Run all tests in order
    for test_file in "${SCRIPT_DIR}"/[0-9][0-9]-*.sh; do
      [[ -f "$test_file" ]] || continue
      run_test "$test_file"
    done
  fi

  echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  Passed: ${TESTS_PASSED}${NC}"
  echo -e "${RED}  Failed: ${TESTS_FAILED}${NC}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  [[ $TESTS_FAILED -eq 0 ]]
}

main "$@"
