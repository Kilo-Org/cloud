#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-kiloclaw:controller}"
TOKEN="${TOKEN:-smoke-token}"
PORT="${PORT:-18790}"
KILOCODE_API_KEY="${KILOCODE_API_KEY:-smoke-kilocode-key}"

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
echo "gateway status (no auth) -> expect 401:"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/_kilo/gateway/status"

echo "gateway status (bearer auth) -> expect 200:"
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/_kilo/gateway/status"

echo "user traffic without proxy token (REQUIRE_PROXY_TOKEN=true) -> expect 401:"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/"

echo "container logs:"
docker logs --tail 120 "$CID"
