#!/bin/sh
# Run `wrangler dev` with a local Docker socket proxy that injects
# HostConfig.Privileged=true for SandboxSmall (Docker-in-Docker).
#
# See scripts/docker-privileged-proxy.mjs for context.
# Args after `--` are forwarded to wrangler dev.

set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
service_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"

# Unix-domain sockets have a ~104-byte path limit on macOS, so we cannot put
# the socket under the worktree's .wrangler/ directory. Derive a short stable
# path under $TMPDIR keyed on the service directory so multiple worktrees can
# coexist.
hash="$(printf '%s' "$service_dir" | shasum | cut -c1-10)"
socket="${DOCKER_PROXY_SOCKET:-${TMPDIR:-/tmp}/cloud-agent-dind-${hash}.sock}"
# Strip any trailing slash $TMPDIR may carry on macOS.
socket="$(printf '%s' "$socket" | sed 's:/\{1,\}:/:g')"
export DOCKER_PROXY_SOCKET="$socket"

node "$script_dir/docker-privileged-proxy.mjs" &
proxy=$!
trap 'kill $proxy 2>/dev/null || true' EXIT INT TERM

i=0
while [ $i -lt 100 ]; do
  [ -S "$socket" ] && break
  sleep 0.1
  i=$((i + 1))
done

if [ ! -S "$socket" ]; then
  echo "Docker proxy socket not found at $socket." >&2
  exit 1
fi

DOCKER_HOST="unix://$socket" exec wrangler dev "$@"
