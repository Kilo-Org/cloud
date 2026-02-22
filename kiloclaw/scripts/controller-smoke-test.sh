#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-kiloclaw:controller}"
TOKEN="${TOKEN:-smoke-token}"
PORT="${PORT:-18789}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Image '$IMAGE' is not available locally."
  echo "Build it first from /Users/syn/projects/cloud-alt/kiloclaw:"
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
  -e KILOCLAW_GATEWAY_ARGS='["--port","3001","--verbose","--allow-unconfigured","--bind","loopback","--token","smoke-token"]' \
  -e REQUIRE_PROXY_TOKEN=true \
  --entrypoint node \
  "$IMAGE" /usr/local/bin/kiloclaw-controller.js)

sleep 4

echo "health:"
curl -sS "http://127.0.0.1:${PORT}/health"

echo
echo "gateway status (no auth) -> expect 401:"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/gateway/status"

echo "gateway status (bearer auth) -> expect 200:"
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:${PORT}/gateway/status"

echo "user traffic without proxy token (REQUIRE_PROXY_TOKEN=true) -> expect 401:"
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:${PORT}/"

echo "container logs:"
docker logs --tail 80 "$CID"
