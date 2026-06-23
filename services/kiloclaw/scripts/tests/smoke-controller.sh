#!/usr/bin/env bash
set -euo pipefail

# Controller smoke test — starts a fresh container (no pre-seeded config),
# waits for the full bootstrap (onboard path), then verifies controller
# HTTP endpoints, auth, and env patching.
#
# For the volume-mount doctor path, use smoke-entrypoint.sh.

IMAGE="${IMAGE:-kiloclaw:controller}"
TOKEN="${TOKEN:-smoke-token}"
PORT="${PORT:-18789}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$SCRIPT_DIR/smoke-helpers.sh"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' is not available locally."
  echo "Build it first from the kiloclaw directory:"
  echo "  docker build --progress=plain -t $IMAGE ."
  exit 1
fi

CID=""
cleanup() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

CID=$(docker run -d --rm \
  -p "$PORT:18789" \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e KILOCODE_API_KEY="smoke-key" \
  -e REQUIRE_PROXY_TOKEN=true \
  "$IMAGE")

# Wait for controller to reach "ready" state
echo "waiting for controller on port $PORT ..."
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

assert_kilo_chat_smoke "$CID" "$PORT" "$TOKEN"

echo
echo "--- proxy token ---"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/")
check "root without proxy token (REQUIRE_PROXY_TOKEN=true) -> 401" "401" "$CODE"

echo
echo "--- env patch endpoint ---"

CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  -d '{"KILOCODE_API_KEY":"fresh-key"}' \
  "http://127.0.0.1:${PORT}/_kilo/env/patch")
check "env patch (no auth) -> 401" "401" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"PATH":"/usr/bin"}' \
  "http://127.0.0.1:${PORT}/_kilo/env/patch")
check "env patch (non-patchable key) -> 400" "400" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' \
  "http://127.0.0.1:${PORT}/_kilo/env/patch")
check "env patch (empty body) -> 400" "400" "$CODE"

echo
echo "--- auth store SecretRef mode (SQLite) ---"

# Onboard runs with --secret-input-mode ref, so the kilocode key is stored as an
# env-backed keyRef, never as a plaintext literal on disk. OpenClaw 2026.6.1+
# keeps auth profiles in the per-agent SQLite store (openclaw-agent.sqlite)
# rather than auth-profiles.json. A regression that wrote the literal
# KILOCODE_API_KEY to disk would shadow env-based rotation.
AGENT_DIR="/root/.openclaw/agents/main/agent"

if docker exec "$CID" sh -c "[ -f '$AGENT_DIR/openclaw-agent.sqlite' ]"; then
  check "SQLite auth store present" "1" "1"
else
  check "SQLite auth store present" "1" "0"
fi

# The literal onboarding key (KILOCODE_API_KEY=smoke-key) must never be written
# to disk under the agent dir — the keyRef points back at the env var instead.
PLAINTEXT_HITS=$(docker exec "$CID" sh -c "grep -ral 'smoke-key' '$AGENT_DIR' 2>/dev/null | wc -l | tr -d ' '")
check "no plaintext kilocode key on disk" "0" "$PLAINTEXT_HITS"

echo
echo "--- env patch rotation semantics ---"

# supervisor.restart() sends SIGTERM → child exit → controller respawn with
# fresh env. Regressing to SIGUSR1 (with OPENCLAW_NO_RESPAWN=1) or
# 'secrets reload' would leave the PID unchanged and env unpropagated.
PID_BEFORE=$(docker exec "$CID" pgrep -f 'openclaw.*gateway' | head -1 || echo "")

ROT_RESP=$(curl -sS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"KILOCODE_API_KEY":"rotated-smoke-key-12345"}' \
  "http://127.0.0.1:${PORT}/_kilo/env/patch")

ROT_OK=$(echo "$ROT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok'))" 2>/dev/null || echo "")
ROT_SIGNALED=$(echo "$ROT_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('signaled'))" 2>/dev/null || echo "")
check "env patch response ok=True"       "True" "$ROT_OK"
# Wire contract with the worker's EnvPatchResponseSchema — a rename here
# would break reconcile.ts silently.
check "env patch response signaled=True" "True" "$ROT_SIGNALED"

# Wait for the fire-and-forget restart: SIGTERM drain + spawn usually <5s.
sleep 6
PID_AFTER=$(docker exec "$CID" pgrep -f 'openclaw.*gateway' | head -1 || echo "")

if [ -n "$PID_BEFORE" ] && [ -n "$PID_AFTER" ] && [ "$PID_BEFORE" != "$PID_AFTER" ]; then
  check "gateway pid changed after env patch" "1" "1"
else
  check "gateway pid changed after env patch" "1" "0"
  echo "  before=$PID_BEFORE after=$PID_AFTER"
fi

echo
echo "--- version endpoint ---"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/_kilo/version")
check "version (no auth) -> 401" "401" "$CODE"

CODE=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/version")
check "version (bearer auth) -> 200" "200" "$CODE"

echo
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "container logs:"
  docker logs --tail 40 "$CID"
  exit 1
fi
