#!/bin/sh
# Run Wrangler with the Docker endpoint and ARM egress image configured.

set -eu

probe_docker_architecture() {
  if [ -n "${DOCKER_SOCKET:-}" ]; then
    case "$DOCKER_SOCKET" in
      unix://*) probe_docker_host="$DOCKER_SOCKET" ;;
      *) probe_docker_host="unix://$DOCKER_SOCKET" ;;
    esac
    DOCKER_HOST="$probe_docker_host" docker info --format '{{.Architecture}}'
    return
  fi

  docker info --format '{{.Architecture}}'
}

if [ -z "${MINIFLARE_CONTAINER_EGRESS_IMAGE:-}" ]; then
  docker_arch="$(probe_docker_architecture 2>/dev/null || true)"
  case "$docker_arch" in
    aarch64 | arm64)
      # Work around wrangler/miniflare launching the amd64 proxy-everything
      # image on arm64 Docker engines, which exits with:
      # "setsockoptint: protocol not available".
      export MINIFLARE_CONTAINER_EGRESS_IMAGE="cloudflare/proxy-everything:3cb1195@sha256:78c7910f4575a511d928d7824b1cbcaec6b7c4bf4dbb3fafaeeae3104030e73c"
      ;;
  esac
fi

if [ -n "${DOCKER_SOCKET:-}" ]; then
  case "$DOCKER_SOCKET" in
    unix://*) export DOCKER_HOST="$DOCKER_SOCKET" ;;
    *) export DOCKER_HOST="unix://$DOCKER_SOCKET" ;;
  esac
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
service_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
has_config=0
for arg in "$@"; do
  case "$arg" in --config | --config=* | -c | -c*) has_config=1 ;; esac
done
if [ "$has_config" = 0 ] && [ -f "$service_dir/wrangler.kilo2-local.json" ]; then
  set -- "$@" --config "$service_dir/wrangler.kilo2-local.json"
fi
exec wrangler dev "$@"
