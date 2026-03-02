#!/usr/bin/env bash
# Shared helpers for E2E tests. Source this at the top of each test.

BASE_URL="${BASE_URL:-http://localhost:9787}"
HTTP_STATUS=""
HTTP_BODY=""

# Generate a unique user ID for this test run
unique_user_id() {
  echo "e2e-user-$(date +%s)-${RANDOM}"
}

# Temp files for IPC between subshell and parent
_E2E_STATUS_FILE=$(mktemp)
_E2E_BODY_FILE=$(mktemp)

_e2e_cleanup_tmpfiles() {
  rm -f "$_E2E_STATUS_FILE" "$_E2E_BODY_FILE" 2>/dev/null
}
trap _e2e_cleanup_tmpfiles EXIT

# Set this to a town ID to have it sent as X-Town-Id header on all requests
CURRENT_TOWN_ID=""

# Generic fetch: api_call METHOD PATH [BODY]
# Sets $HTTP_STATUS and $HTTP_BODY
api_call() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${BASE_URL}${path}"

  local curl_args=(-s -o "$_E2E_BODY_FILE" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json')
  if [[ -n "$CURRENT_TOWN_ID" ]]; then
    curl_args+=(-H "X-Town-Id: ${CURRENT_TOWN_ID}")
  fi
  if [[ -n "$body" ]]; then
    curl_args+=(-d "$body")
  fi

  HTTP_STATUS=$(curl "${curl_args[@]}" "$url" 2>/dev/null)
  HTTP_BODY=$(cat "$_E2E_BODY_FILE")
}

api_get()  { api_call GET  "$1"; }
api_post() { api_call POST "$1" "${2:-}"; }

assert_eq() {
  local actual="$1"
  local expected="$2"
  local msg="${3:-}"
  if [[ "$actual" != "$expected" ]]; then
    echo "    ASSERT FAILED: ${msg}"
    echo "      expected: $expected"
    echo "      actual:   $actual"
    return 1
  fi
}

assert_status() {
  local expected="$1"
  local msg="${2:-HTTP status check}"
  assert_eq "$HTTP_STATUS" "$expected" "$msg"
}

assert_json() {
  local json="$1"
  local field="$2"
  local expected="$3"
  local msg="${4:-json field $field}"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null)
  assert_eq "$actual" "$expected" "$msg"
}

assert_json_exists() {
  local json="$1"
  local field="$2"
  local msg="${3:-json field $field should exist}"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null)
  if [[ "$actual" == "null" || -z "$actual" ]]; then
    echo "    ASSERT FAILED: ${msg} (got null/empty)"
    return 1
  fi
}

assert_json_not_empty() {
  local json="$1"
  local field="$2"
  local msg="${3:-json field $field should not be empty}"
  local actual
  actual=$(echo "$json" | jq -r "$field" 2>/dev/null)
  if [[ -z "$actual" || "$actual" == "null" || "$actual" == "" ]]; then
    echo "    ASSERT FAILED: ${msg} (got: '$actual')"
    return 1
  fi
}

# Wait for a condition to be true, polling every $interval seconds
wait_for() {
  local description="$1"
  local check_cmd="$2"
  local max_seconds="${3:-30}"
  local interval="${4:-1}"

  local elapsed=0
  while [[ $elapsed -lt $max_seconds ]]; do
    if eval "$check_cmd" 2>/dev/null; then
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  echo "    TIMEOUT: ${description} (waited ${max_seconds}s)"
  return 1
}
