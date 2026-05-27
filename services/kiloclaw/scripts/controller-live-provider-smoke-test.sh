#!/usr/bin/env bash
set -euo pipefail

# Live packaged-image smoke for KiloClaw + real Kilo Gateway routing.
# This script intentionally uses Auto Free and sends only a generated nonce prompt.
# It is opt-in/manual because it requires live credentials and free-model availability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-kiloclaw:controller}"
IMAGE_BEFORE="${IMAGE_BEFORE:-$IMAGE}"
IMAGE_AFTER="${IMAGE_AFTER:-$IMAGE}"
PORT="${PORT:-18791}"
TOKEN="${TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
KILOCODE_CONFIG_PATH="${KILOCODE_CONFIG_PATH:-$HOME/.kilocode/cli/config.json}"
KILOCODE_SMOKE_MODEL="${KILOCODE_SMOKE_MODEL:-kilocode/kilo-auto/free}"
EXPECTED_VERSION_BEFORE="${EXPECTED_VERSION_BEFORE:-}"
EXPECTED_VERSION_AFTER="${EXPECTED_VERSION_AFTER:-}"
MODE="fresh"

source "$SCRIPT_DIR/controller-smoke-helpers.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/controller-live-provider-smoke-test.sh [--upgrade]

Runs a packaged KiloClaw image against the real Kilo Gateway using the Auto Free
model by default. Provide KILOCODE_API_KEY explicitly or authenticate with the
Kilo CLI locally so ~/.kilocode/cli/config.json contains an active token.

Options:
  --upgrade  Boot IMAGE_BEFORE, then IMAGE_AFTER on the same temporary /root.

Optional version assertions:
  EXPECTED_VERSION_AFTER   Expected OpenClaw version for the candidate/final image.
  EXPECTED_VERSION_BEFORE  Expected OpenClaw version for --upgrade baseline image.
EOF
}

case "${1:-}" in
  "") ;;
  --upgrade) MODE="upgrade" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

read_active_provider_value() {
  local field="$1"
  python3 - "$KILOCODE_CONFIG_PATH" "$field" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1]).expanduser()
field = sys.argv[2]
try:
    document = json.loads(path.read_text())
except FileNotFoundError:
    raise SystemExit(0)
except (OSError, json.JSONDecodeError) as error:
    print(f'Unable to read Kilo CLI config at {path}: {error}', file=sys.stderr)
    raise SystemExit(1)

active_id = document.get('provider')
providers = document.get('providers', [])
if not isinstance(active_id, str) or not isinstance(providers, list):
    raise SystemExit(0)

for provider in providers:
    if not isinstance(provider, dict) or provider.get('id') != active_id:
        continue
    value = provider.get(field)
    if isinstance(value, str) and value:
        sys.stdout.write(value)
    raise SystemExit(0)
PY
}

CREDENTIAL_SOURCE="environment"
if [ -z "${KILOCODE_API_KEY:-}" ]; then
  KILOCODE_API_KEY="$(read_active_provider_value kilocodeToken)"
  CREDENTIAL_SOURCE="local Kilo CLI config"
fi
if [ -z "${KILOCODE_API_KEY:-}" ]; then
  echo "Missing KILOCODE_API_KEY and no active kilocodeToken was found in $KILOCODE_CONFIG_PATH." >&2
  echo "Export KILOCODE_API_KEY or authenticate with the Kilo CLI before running this live smoke." >&2
  exit 1
fi

if [ -z "${KILOCODE_ORGANIZATION_ID:-}" ] && [ "$CREDENTIAL_SOURCE" = "local Kilo CLI config" ]; then
  KILOCODE_ORGANIZATION_ID="$(read_active_provider_value kilocodeOrganizationId)"
fi

export KILOCODE_API_KEY
export KILOCODE_DEFAULT_MODEL="$KILOCODE_SMOKE_MODEL"
if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
  export KILOCODE_ORGANIZATION_ID
fi

for image in "$IMAGE_AFTER"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "Image '$image' is not available locally." >&2
    echo "Build it first from the kiloclaw directory:" >&2
    echo "  docker buildx build --build-context workspace=../.. --load -t $image ." >&2
    exit 1
  fi
done
if [ "$MODE" = "upgrade" ] && ! docker image inspect "$IMAGE_BEFORE" >/dev/null 2>&1; then
  echo "Image '$IMAGE_BEFORE' is not available locally." >&2
  exit 1
fi

ROOTDIR="$(mktemp -d)"
CID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROOTDIR"
}
trap cleanup EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

start_container() {
  local image="$1"
  local -a docker_env=(
    -e OPENCLAW_GATEWAY_TOKEN="$TOKEN"
    -e KILOCODE_API_KEY
    -e KILOCODE_DEFAULT_MODEL
    -e REQUIRE_PROXY_TOKEN=true
  )
  if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
    docker_env+=(-e KILOCODE_ORGANIZATION_ID)
  fi
  CID=$(docker run -d --rm \
    -p "127.0.0.1:${PORT}:18789" \
    "${docker_env[@]}" \
    -v "$ROOTDIR:/root" \
    "$image")
}

stop_container() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
    CID=""
  fi
}

wait_for_ready() {
  local label="$1"
  local response=""
  local state=""

  echo "waiting for $label controller on port $PORT ..."
  for i in $(seq 1 120); do
    response=$(curl -sS "http://127.0.0.1:${PORT}/_kilo/health" 2>/dev/null || true)
    if [[ "$response" == \{* ]]; then
      state=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", ""))' <<< "$response" 2>/dev/null || true)
      case "$state" in
        ready) echo "  ready after ${i}s"; return 0 ;;
        degraded) echo "  DEGRADED: $response"; break ;;
        *) echo "  [$i] state=$state" ;;
      esac
    else
      echo "  [$i] waiting..."
    fi
    sleep 1
  done

  echo "FAIL: $label controller did not reach ready state"
  echo "  Container logs suppressed because startup errors can contain live credentials."
  echo "  Reproduce with disposable credentials before inspecting raw container logs."
  return 1
}

assert_configured_model() {
  local model
  model=$(docker exec -i "$CID" python3 - <<'PY'
import json
from pathlib import Path

doc = json.loads(Path('/root/.openclaw/openclaw.json').read_text())
print(doc.get('agents', {}).get('defaults', {}).get('model', {}).get('primary', ''))
PY
  )
  check "configured live smoke model" "$KILOCODE_SMOKE_MODEL" "$model"
}

assert_openclaw_version() {
  local expected="$1"
  local output
  local actual

  if [ -z "$expected" ]; then
    return
  fi
  output=$(docker exec "$CID" openclaw --version 2>/dev/null || true)
  actual=$(python3 -c 'import re, sys; match = re.search(r"OpenClaw\s+(\S+)", sys.stdin.read()); print(match.group(1) if match else "")' <<< "$output")
  check "OpenClaw version" "$expected" "$actual"
}

assert_openclaw_config_valid() {
  local output
  local result="invalid"

  if output=$(docker exec "$CID" openclaw config validate --json 2>/dev/null); then
    result=$(python3 -c '
import json
import sys

try:
    doc = json.load(sys.stdin)
except json.JSONDecodeError:
    print("invalid")
    raise SystemExit(0)
print("valid" if doc.get("valid") is True else "invalid")
' <<< "$output")
  fi

  check "OpenClaw config validate" "valid" "$result"
}

assert_gateway_status() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:${PORT}/_kilo/gateway/status")
  check "gateway status (bearer auth) -> 200" "200" "$code"
}

assert_control_ui_proxy() {
  local html
  local result="missing"

  for _ in $(seq 1 30); do
    html=$(curl -sS \
      -H "x-kiloclaw-proxy-token: $TOKEN" \
      "http://127.0.0.1:${PORT}/" 2>/dev/null || true)
    if [[ "$html" == *"<title>OpenClaw Control</title>"* && "$html" == *"<openclaw-app></openclaw-app>"* ]]; then
      result="ready"
      break
    fi
    sleep 1
  done

  check "proxied Control UI HTML" "ready" "$result"
}

assert_live_agent_turn() {
  local nonce
  local session_id
  local params
  local output
  local parsed

  nonce="KILOCLAW_SMOKE_$(python3 -c 'import secrets; print(secrets.token_hex(8).upper())')"
  session_id="kiloclaw-live-smoke-$(date +%s)"
  params=$(python3 - "$nonce" "$session_id" <<'PY'
import json
import sys

nonce = sys.argv[1]
session_id = sys.argv[2]
print(json.dumps({
    'message': f'Reply with exactly this token and no other text: {nonce}',
    'agentId': 'main',
    'sessionId': session_id,
    'idempotencyKey': session_id,
    'timeout': 180,
}))
PY
  )

  if ! output=$(docker exec "$CID" openclaw gateway call agent \
    --params "$params" \
    --expect-final \
    --timeout 240000 \
    --json 2>&1); then
    check "live Auto Free agent turn" "nonce returned" "command failed"
    echo "  Gateway output suppressed because provider errors can contain live credentials."
    return
  fi

  if parsed=$(python3 -c '
import json
import sys

nonce = sys.argv[1]
doc = json.load(sys.stdin)
result = doc.get("result", doc)
payloads = result.get("payloads", []) if isinstance(result, dict) else []
texts = [entry.get("text", "") for entry in payloads if isinstance(entry, dict)]
if not any(nonce in text for text in texts):
    raise SystemExit("response did not contain nonce")
print("nonce returned")
' "$nonce" <<< "$output" 2>&1); then
    check "live Auto Free agent turn" "nonce returned" "$parsed"
  else
    check "live Auto Free agent turn" "nonce returned" "unexpected response"
    echo "  details: $parsed"
    echo "  Gateway output suppressed because provider responses can contain sensitive data."
  fi
}

run_phase() {
  local label="$1"
  local image="$2"
  local expected_version="$3"

  echo
  echo "=== $label: $image ==="
  start_container "$image"
  wait_for_ready "$label"
  assert_openclaw_version "$expected_version"
  assert_openclaw_config_valid
  assert_gateway_status
  assert_control_ui_proxy
  assert_configured_model
  assert_kilo_chat_smoke "$CID" "$PORT" "$TOKEN"
  echo
  echo "--- live Auto Free agent turn ---"
  assert_live_agent_turn
  stop_container
}

echo "Credential source: $CREDENTIAL_SOURCE"
echo "Model under test: $KILOCODE_SMOKE_MODEL"
if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
  echo "Organization scope: configured"
else
  echo "Organization scope: not configured"
fi

if [ "$MODE" = "upgrade" ]; then
  run_phase "before-image" "$IMAGE_BEFORE" "$EXPECTED_VERSION_BEFORE"
  run_phase "after-image persisted-root" "$IMAGE_AFTER" "$EXPECTED_VERSION_AFTER"
else
  run_phase "candidate-image" "$IMAGE_AFTER" "$EXPECTED_VERSION_AFTER"
fi

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
