#!/bin/sh
# Build a local Docker image for the docker-local provider.
#
# Usage: ./scripts/build-local-image.sh [--local] [image-tag]
#   --local    Use Dockerfile.local and a local openclaw tarball from openclaw-build/
#   image-tag  defaults to DOCKER_LOCAL_IMAGE from .dev.vars, or "kiloclaw:local"

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"

USE_LOCAL=false
for arg in "$@"; do
  case "$arg" in
    --local) USE_LOCAL=true; shift ;;
  esac
done

if [ "$USE_LOCAL" = true ]; then
  DOCKERFILE="$KILOCLAW_DIR/Dockerfile.local"
  if ! ls "$KILOCLAW_DIR"/openclaw-build/openclaw-*.tgz 1>/dev/null 2>&1; then
    echo "Error: No openclaw-*.tgz found in openclaw-build/." >&2
    echo "Build your fork first:" >&2
    echo "  cd /path/to/openclaw && pnpm build && npm pack" >&2
    echo "  cp openclaw-*.tgz $(cd "$KILOCLAW_DIR" && pwd)/openclaw-build/" >&2
    exit 1
  fi
  echo "Using Dockerfile.local (local OpenClaw tarball)"
else
  DOCKERFILE="$KILOCLAW_DIR/Dockerfile"
fi

IMAGE="${1:-}"
if [ -z "$IMAGE" ] && [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
  IMAGE=$(grep '^DOCKER_LOCAL_IMAGE=' "$KILOCLAW_DIR/.dev.vars" | cut -d= -f2)
fi
IMAGE="${IMAGE:-kiloclaw:local}"
GIT_SHA="$(git -C "$KILOCLAW_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')"

echo "Building local image $IMAGE ..."
docker build \
  -f "$DOCKERFILE" \
  --build-arg "CONTROLLER_COMMIT=$GIT_SHA" \
  --build-arg "CONTROLLER_CACHE_BUST=$(date +%s)" \
  -t "$IMAGE" \
  "$KILOCLAW_DIR"

echo ""
echo "Done. docker-local can now use:"
echo "  DOCKER_LOCAL_IMAGE=$IMAGE"
