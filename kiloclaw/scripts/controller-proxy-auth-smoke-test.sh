#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-kiloclaw:controller}"
TOKEN="${TOKEN:-smoke-token}"
PORT="${PORT:-18791}"
KILOCODE_API_KEY="${KILOCODE_API_KEY:-smoke-kilocode-key}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' is not available locally."
  echo "Build it first from /Users/syn/projects/cloud-alt/kiloclaw:"
  echo "  docker build --progress=plain -t $IMAGE ."
  exit 1
fi

ROOTDIR="$(mktemp -d)"
mkdir -p "$ROOTDIR/.openclaw" "$ROOTDIR/clawd"
cat > "$ROOTDIR/.openclaw/openclaw.json" <<'JSON'
{}
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

echo "waiting for /_kilo/health on port $PORT ..."
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/_kilo/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "health:"
curl -sS "http://127.0.0.1:${PORT}/_kilo/health"

echo
echo "proxy without token -> expect 401:"
UNAUTH_CODE="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/")"
echo "$UNAUTH_CODE"
if [ "$UNAUTH_CODE" != "401" ]; then
  echo "expected 401 without proxy token, got $UNAUTH_CODE"
  docker logs --tail 120 "$CID"
  exit 1
fi

echo "proxy with token -> expect pass-through (non-401, non-502/503 once ready):"
AUTH_CODE=""
AUTH_BODY=""
for _ in $(seq 1 30); do
  AUTH_BODY="$(mktemp)"
  AUTH_CODE="$(curl -s -o "$AUTH_BODY" -w "%{http_code}" \
    -H "x-kiloclaw-proxy-token: $TOKEN" \
    "http://127.0.0.1:${PORT}/")"

  if [ "$AUTH_CODE" != "401" ] && [ "$AUTH_CODE" != "502" ] && [ "$AUTH_CODE" != "503" ]; then
    break
  fi
  rm -f "$AUTH_BODY"
  AUTH_BODY=""
  sleep 1
done

echo "$AUTH_CODE"
if [ "$AUTH_CODE" = "401" ] || [ "$AUTH_CODE" = "502" ] || [ "$AUTH_CODE" = "503" ]; then
  echo "expected authenticated proxy pass-through, got status $AUTH_CODE"
  if [ -n "$AUTH_BODY" ] && [ -f "$AUTH_BODY" ]; then
    echo "response body:"
    cat "$AUTH_BODY"
  fi
  docker logs --tail 120 "$CID"
  exit 1
fi

if [ -n "$AUTH_BODY" ] && [ -f "$AUTH_BODY" ]; then
  rm -f "$AUTH_BODY"
fi

echo "container logs:"
docker logs --tail 120 "$CID"
