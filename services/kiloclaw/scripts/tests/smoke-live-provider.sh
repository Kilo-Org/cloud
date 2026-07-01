#!/usr/bin/env bash
set -euo pipefail

# Live packaged-image smoke for KiloClaw + real Kilo Gateway routing.
# This script intentionally uses Auto Free and sends only a generated nonce prompt.
# It is opt-in/manual because it requires live credentials and free-model availability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-kiloclaw:controller}"
IMAGE_BEFORE="${IMAGE_BEFORE:-$IMAGE}"
IMAGE_AFTER="${IMAGE_AFTER:-$IMAGE}"
# Default to a free ephemeral loopback port so the smoke never collides with a
# running dev stack (e.g. workerd holding the old fixed 18791). Set PORT to pin
# one. The brief bind/close races against `docker run`, but on a random high port
# a collision is far less likely than the previous fixed default.
PORT="${PORT:-$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')}"
TOKEN="${TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
KILOCODE_CONFIG_PATH="${KILOCODE_CONFIG_PATH:-$HOME/.kilocode/cli/config.json}"
KILOCODE_SMOKE_MODEL="${KILOCODE_SMOKE_MODEL:-kilocode/kilo-auto/free}"
EXPECTED_VERSION_BEFORE="${EXPECTED_VERSION_BEFORE:-}"
EXPECTED_VERSION_AFTER="${EXPECTED_VERSION_AFTER:-}"
MODE="fresh"

source "$SCRIPT_DIR/smoke-helpers.sh"
source "$SCRIPT_DIR/provider-creds.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/tests/smoke-live-provider.sh [--upgrade]

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
# openclaw >=2026.6.11 may print log lines (e.g. "[state-migrations] ...") on
# stderr, which the 2>&1 capture interleaves ahead of the JSON payload. A bare
# "[state-migrations]" line also begins with "[", and a log line may contain a
# stray "{", so we cannot just take the first bracket — try every "["/"{"
# candidate offset until one decodes.
raw = sys.stdin.read()
doc = None
for _start in [0] + [i for i, c in enumerate(raw) if c in "[{"]:
    try:
        _cand, _ = json.JSONDecoder().raw_decode(raw[_start:])
    except Exception:
        continue
    # Accept only the real response object, not a self-contained JSON fragment
    # (e.g. a stray list) embedded in an interleaved log line.
    if isinstance(_cand, dict) and ("result" in _cand or "payloads" in _cand):
        doc = _cand
        break
if doc is None:
    raise SystemExit("no result JSON object in command output")
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

assert_kilocode_vision_capability() {
  # Regression guard for the removed model-catalog-refresh workaround (was cloud
  # #4054). That workaround wrote the gateway catalog into
  # models.providers.kilocode.models so the image-capability gate saw vision
  # modalities, because OpenClaw <2026.6.9 could skip runtime discovery for a
  # refreshable catalog (openclaw #93775). openclaw #93786 (in 2026.6.9) fixes
  # that, so on the candidate the kilocode catalog must advertise image input
  # from NATIVE discovery alone. An "available" kilocode model with image input
  # proves discovery repopulated capability metadata without the workaround.
  local output
  local result="pending"

  for _ in $(seq 1 60); do
    output=$(docker exec "$CID" openclaw models list --provider kilocode --all --json 2>/dev/null || true)
    result=$(python3 -c '
import json, sys

raw = sys.stdin.read()
# Tolerate any non-JSON log preamble (e.g. openclaw [state-migrations]) by trying
# each candidate JSON start until one decodes to the model catalog shape. A bare
# "[state-migrations]" line also begins with "[", and a self-contained fragment
# (e.g. a stray list) in an interleaved log line could parse on its own, so accept
# only a top-level list of model objects (or a dict with a "models" list).
def _as_catalog(cand):
    if isinstance(cand, dict) and isinstance(cand.get("models"), list):
        cand = cand["models"]
    # Require a non-empty list whose entries look like model objects (have a
    # "key" or "provider"), so an empty list or a stray list of unrelated dicts
    # from interleaved log noise is not mistaken for the real catalog.
    if (
        isinstance(cand, list)
        and cand
        and all(isinstance(x, dict) for x in cand)
        and any(("key" in x or "provider" in x) for x in cand)
    ):
        return cand
    return None

models = None
for start in [0] + [i for i, c in enumerate(raw) if c in "[{"]:
    try:
        cand, _ = json.JSONDecoder().raw_decode(raw[start:])
    except Exception:
        continue
    models = _as_catalog(cand)
    if models is not None:
        break
if models is None:
    print("no-catalog"); raise SystemExit(0)

def is_kilocode(m):
    return str(m.get("key", "")).startswith("kilocode/") or m.get("provider") == "kilocode"

def has_image(m):
    inp = m.get("input")
    if isinstance(inp, str):
        return "image" in inp
    if isinstance(inp, (list, tuple)):
        return "image" in inp
    return False

kc = [m for m in models if isinstance(m, dict) and is_kilocode(m)]
if any(has_image(m) and m.get("available") is True for m in kc):
    print("image-capable")
elif any(has_image(m) for m in kc):
    print("image-capable-unavailable")
elif kc:
    print("text-only")
else:
    print("no-kilocode-models")
' <<< "$output")
    if [ "$result" = "image-capable" ]; then
      break
    fi
    sleep 1
  done

  check "kilocode native vision capability (post-#4054-revert)" "image-capable" "$result"
}

run_phase() {
  local label="$1"
  local image="$2"
  local expected_version="$3"
  # 1 = run the app config-write assertions (they MUTATE openclaw.json). Default 1.
  local mutate_config="${4:-1}"

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
  # The app config-write routes rewrite openclaw.json. In --upgrade mode they run
  # ONLY on the candidate — after it has booted on the UNTOUCHED baseline-generated
  # root — so the baseline CLI does not rewrite the persisted config first and mask
  # an incompatibility in how the candidate reads the original baseline config.
  if [ "$mutate_config" = "1" ]; then
    assert_app_config_patch "$CID" "$PORT" "$TOKEN"
    assert_app_config_agent_defaults "$CID" "$PORT" "$TOKEN"
    assert_app_config_agents_crud "$CID" "$PORT" "$TOKEN"
    # Candidate only: prove the removed #4054 catalog-refresh workaround is no
    # longer needed — native discovery must supply kilocode image capability.
    assert_kilocode_vision_capability
  fi
  assert_exec_approvals_seeded "$CID"
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
  # Baseline: no config mutations, so its persisted root stays the pristine
  # baseline-generated config the candidate then boots against.
  run_phase "before-image" "$IMAGE_BEFORE" "$EXPECTED_VERSION_BEFORE" 0
  # Candidate: boots on the untouched baseline root, then exercises the config-write
  # routes against the upgraded image.
  run_phase "after-image persisted-root" "$IMAGE_AFTER" "$EXPECTED_VERSION_AFTER" 1
else
  run_phase "candidate-image" "$IMAGE_AFTER" "$EXPECTED_VERSION_AFTER" 1
fi

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
