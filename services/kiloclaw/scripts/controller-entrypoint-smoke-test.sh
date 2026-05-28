#!/usr/bin/env bash
set -euo pipefail

# Full entrypoint smoke test — runs the default CMD (controller with bootstrap).
# Tests the complete startup path: bootstrap → onboard/doctor → config patch → gateway.
# For quick controller-only testing, use controller-smoke-test.sh.

IMAGE="${IMAGE:-kiloclaw:controller}"
TOKEN="${TOKEN:-smoke-token}"
PORT="${PORT:-18790}"
KILOCODE_API_KEY="${KILOCODE_API_KEY:-smoke-kilocode-key}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/controller-smoke-helpers.sh"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' is not available locally."
  echo "Build it first from the kiloclaw directory:"
  echo "  docker build --progress=plain -t $IMAGE ."
  exit 1
fi

ROOTDIR="$(mktemp -d)"
mkdir -p "$ROOTDIR/.openclaw" "$ROOTDIR/clawd"
cat > "$ROOTDIR/.openclaw/openclaw.json" <<'JSON'
{}
JSON

# Seed a legacy auth-profiles.json with a plaintext kilocode key. The
# migration in runOnboardOrDoctor (bootstrap.ts) must rewrite this to an
# env-backed keyRef before the gateway starts, so the respawned gateway
# never reads a stale literal from disk.
mkdir -p "$ROOTDIR/.openclaw/agents/main/agent"
cat > "$ROOTDIR/.openclaw/agents/main/agent/auth-profiles.json" <<'JSON'
{
  "version": 1,
  "profiles": {
    "kilocode:default": {
      "type": "api_key",
      "provider": "kilocode",
      "key": "legacy-plaintext-must-be-rewritten"
    }
  }
}
JSON

CID=""
cleanup() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROOTDIR"
}
trap cleanup EXIT

CID=$(docker run -d --rm \
  -p "$PORT:18789" \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e KILOCODE_API_KEY="$KILOCODE_API_KEY" \
  -e REQUIRE_PROXY_TOKEN=true \
  -v "$ROOTDIR:/root" \
  "$IMAGE")

# Wait for controller to reach "ready" state
echo "waiting for /_kilo/health on port $PORT ..."
READY=false
for i in $(seq 1 60); do
  RESP=$(curl -sS "http://127.0.0.1:${PORT}/_kilo/health" 2>/dev/null) || true
  # Only parse if it looks like JSON
  if echo "$RESP" | grep -q '^{'; then
    STATE=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || true)
    case "$STATE" in
      ready)    echo "  ready after ${i}s"; READY=true; break ;;
      degraded) echo "  DEGRADED: $RESP"; break ;;
      *)        echo "  [$i] state=$STATE" ;;
    esac
  else
    echo "  [$i] waiting..."
  fi
  sleep 1
done

if [ "$READY" != "true" ]; then
  echo "FAIL: controller did not reach ready state"
  docker logs --tail 40 "$CID"
  exit 1
fi

PASS=0
FAIL=0
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

echo
echo "--- health endpoints ---"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/_kilo/health")
check "/_kilo/health -> 200" "200" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/health")
check "/health -> 200" "200" "$CODE"

echo
echo "--- gateway status ---"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/_kilo/gateway/status")
check "gateway status (no auth) -> 401" "401" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/gateway/status")
check "gateway status (bearer auth) -> 200" "200" "$CODE"

echo
echo "--- agent config CRUD endpoints ---"

TRASH_BIN=$(docker exec "$CID" sh -c 'command -v trash 2>/dev/null || true')
check "trash command omitted from packaged image" "" "$TRASH_BIN"

CREATE_RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"crud-smoke","workspace":"/root/.openclaw/workspace-crud-smoke"}' \
  "http://127.0.0.1:${PORT}/_kilo/config/agents")
CREATE_ID=$(echo "$CREATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('agent',{}).get('id',''))" 2>/dev/null || echo "")
check "create configured agent" "crud-smoke" "$CREATE_ID"

CONFIG_VALIDATE_RESP=$(docker exec "$CID" openclaw config validate --json 2>/dev/null || true)
CONFIG_VALID=$(echo "$CONFIG_VALIDATE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid', False))" 2>/dev/null || echo "")
check "created agent leaves OpenClaw config valid" "True" "$CONFIG_VALID"

LIST_RESP=$(curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/config/agents")
LIST_HAS_AGENT=$(echo "$LIST_RESP" | python3 -c "import sys,json; print(any(a.get('id') == 'crud-smoke' and a.get('configured') for a in json.load(sys.stdin).get('agents', [])))" 2>/dev/null || echo "")
check "list includes created agent" "True" "$LIST_HAS_AGENT"

PATCH_RESP=$(curl -sS -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"set":{"model":{"primary":"kilocode/kilo-auto/balanced"}}}' \
  "http://127.0.0.1:${PORT}/_kilo/config/agents/crud-smoke")
PATCH_MODEL=$(echo "$PATCH_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('agent',{}).get('model',{}).get('primary',''))" 2>/dev/null || echo "")
check "patch updates created agent model" "kilocode/kilo-auto/balanced" "$PATCH_MODEL"

DELETE_RESP=$(curl -sS -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/config/agents/crud-smoke")
DELETE_DISPOSITION=$(echo "$DELETE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('filesystemDisposition',''))" 2>/dev/null || echo "")
check "delete reports unverified filesystem disposition" "unverified" "$DELETE_DISPOSITION"

LIST_AFTER_DELETE=$(curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/config/agents")
LIST_STILL_HAS_AGENT=$(echo "$LIST_AFTER_DELETE" | python3 -c "import sys,json; print(any(a.get('id') == 'crud-smoke' and a.get('configured') for a in json.load(sys.stdin).get('agents', [])))" 2>/dev/null || echo "")
check "deleted agent is no longer configured" "False" "$LIST_STILL_HAS_AGENT"

if [ -d "$ROOTDIR/.openclaw/workspace-crud-smoke" ]; then
  check "packaged no-trash baseline retains deleted workspace" "1" "1"
else
  check "packaged no-trash baseline retains deleted workspace" "1" "0"
fi

echo
echo "--- validation-aware openclaw.json write ---"

CONFIG_SHA_BEFORE=$(python3 -c "import hashlib; print(hashlib.sha256(open('$ROOTDIR/.openclaw/openclaw.json','rb').read()).hexdigest())")
INVALID_WRITE_RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"{\"unexpected_root_key\":true}","mode":"warn-before-write"}' \
  "http://127.0.0.1:${PORT}/_kilo/files/write-openclaw-config")
INVALID_WRITE_OUTCOME=$(echo "$INVALID_WRITE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('outcome',''))" 2>/dev/null || echo "")
CONFIG_SHA_AFTER=$(python3 -c "import hashlib; print(hashlib.sha256(open('$ROOTDIR/.openclaw/openclaw.json','rb').read()).hexdigest())")
check "invalid openclaw write returns validation warning" "openclaw-validation-warning" "$INVALID_WRITE_OUTCOME"
check "invalid openclaw warning leaves config unchanged" "$CONFIG_SHA_BEFORE" "$CONFIG_SHA_AFTER"

assert_kilo_chat_smoke "$CID" "$PORT" "$TOKEN"

echo
echo "--- proxy token ---"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/")
check "root without proxy token (REQUIRE_PROXY_TOKEN=true) -> 401" "401" "$CODE"

echo
echo "--- auth-profiles migration (doctor path) ---"

# The seeded file had a plaintext kilocode key. After bootstrap's migration
# runs, the on-disk file must carry a keyRef and no plaintext.
MIGRATED=$(cat "$ROOTDIR/.openclaw/agents/main/agent/auth-profiles.json" 2>/dev/null || echo "")

if echo "$MIGRATED" | grep -q '"keyRef"'; then
  check "legacy plaintext migrated to keyRef" "1" "1"
else
  check "legacy plaintext migrated to keyRef" "1" "0"
  echo "  actual: $MIGRATED"
fi

if echo "$MIGRATED" | grep -q "legacy-plaintext-must-be-rewritten"; then
  check "legacy plaintext removed from disk" "1" "0"
  echo "  actual: $MIGRATED"
else
  check "legacy plaintext removed from disk" "1" "1"
fi

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "container logs:"
  docker logs --tail 40 "$CID"
  exit 1
fi
