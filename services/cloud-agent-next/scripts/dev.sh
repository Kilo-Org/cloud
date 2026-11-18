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
has_environment=0
expect_environment=0
environment=dev
for arg in "$@"; do
  if [ "$expect_environment" = 1 ]; then
    environment="$arg"
    expect_environment=0
    continue
  fi
  case "$arg" in
    --env | -e) has_environment=1; expect_environment=1 ;;
    --env=*) has_environment=1; environment="${arg#--env=}" ;;
  esac
  case "$arg" in --config | --config=* | -c | -c*) has_config=1 ;; esac
done
if [ "$expect_environment" = 1 ] || [ "$environment" != dev ]; then
  printf '%s\n' 'Local runtime publication requires the dev environment.' >&2
  exit 1
fi
if [ "$has_environment" = 0 ]; then
  set -- "$@" --env dev
fi
if [ "$has_config" = 0 ] && [ -f "$service_dir/wrangler.kilo2-local.json" ]; then
  node -e 'const config = require(process.argv[1]); if (!config.env?.dev?.vars?.RUNTIME_KILO2_ORG_IDS) { console.error("Obsolete baked Kilo v2 configuration. Run node scripts/prepare-kilo2-local.mjs <organization-uuid> to select the downloaded runtime, or remove wrangler.kilo2-local.json for v1."); process.exit(1); }' "$service_dir/wrangler.kilo2-local.json"
  set -- "$@" --config "$service_dir/wrangler.kilo2-local.json"
fi
pnpm exec tsx "$script_dir/publish-runtime.ts" --local
runtime_descriptor="$(node -p "require('$service_dir/.wrangler/runtime-local-vars.json').RUNTIME_RELEASE_DESCRIPTOR")"
kilo2_descriptor="$(node -p "require('$service_dir/.wrangler/runtime-local-vars.json').RUNTIME_RELEASE_DESCRIPTOR_KILO2")"
set -- "$@" --persist-to "$service_dir/.wrangler/state" \
  --var RUNTIME_STARTUP_MODE:downloaded \
  --var NATIVE_RUNTIME_IMAGE:runtime-free \
  --var "RUNTIME_RELEASE_DESCRIPTOR:$runtime_descriptor" \
  --var "RUNTIME_RELEASE_DESCRIPTOR_KILO2:$kilo2_descriptor"
exec wrangler dev "$@"
