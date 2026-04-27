#!/bin/sh
# Build a local Docker image for the docker-local provider.
#
# Usage: ./scripts/build-local-image.sh [options]
#   --local              Use Dockerfile.local and a local openclaw tarball
#   --openclaw PATH      Path to openclaw repo. Builds + packs if no tarball
#                        exists in openclaw-build/. Implies --local.
#   --openclaw-tag VER   OpenClaw version (e.g. "2026.4.9"). With --openclaw,
#                        checks out the matching git tag before building. Without
#                        --openclaw, overrides the npm version in the Dockerfile.
#
# Examples:
#   ./scripts/build-local-image.sh --openclaw ~/Projects/openclaw
#   ./scripts/build-local-image.sh --openclaw ~/Projects/openclaw --openclaw-tag 2026.4.9
#   ./scripts/build-local-image.sh --openclaw-tag 2026.4.9
#   ./scripts/build-local-image.sh --local

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"

USE_LOCAL=false
OPENCLAW_DIR=""
OPENCLAW_TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local) USE_LOCAL=true; shift ;;
    --openclaw)
      OPENCLAW_DIR="$2"
      USE_LOCAL=true
      shift 2
      ;;
    --openclaw-tag)
      OPENCLAW_TAG="$2"
      shift 2
      ;;
    -*)
      echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ── Resolve openclaw tarball when --openclaw is given ──────────────────
if [ -n "$OPENCLAW_DIR" ]; then
  OPENCLAW_DIR="$(cd "$OPENCLAW_DIR" && pwd)"
  if [ ! -f "$OPENCLAW_DIR/package.json" ]; then
    echo "Error: $OPENCLAW_DIR does not look like an openclaw repo (no package.json)" >&2
    exit 1
  fi

  # Check out the requested version tag if specified
  if [ -n "$OPENCLAW_TAG" ]; then
    echo "Checking out openclaw v$OPENCLAW_TAG ..."
    (cd "$OPENCLAW_DIR" && git checkout "v$OPENCLAW_TAG")
  fi

  mkdir -p "$KILOCLAW_DIR/openclaw-build"

  # Always rebuild when a specific tag was requested (tarball may be from a different version)
  if [ -n "$OPENCLAW_TAG" ] || ! ls "$KILOCLAW_DIR"/openclaw-build/openclaw-*.tgz 1>/dev/null 2>&1; then
    rm -f "$KILOCLAW_DIR"/openclaw-build/openclaw-*.tgz
    echo "Building openclaw..."
    (cd "$OPENCLAW_DIR" && pnpm install --frozen-lockfile && pnpm build)
    echo "Packing openclaw..."
    (cd "$OPENCLAW_DIR" && npm pack 2>&1 || true)
    # npm pack may warn "File name too long" but still produces the tarball
    TGZ_PATH="$(ls -t "$OPENCLAW_DIR"/openclaw-*.tgz 2>/dev/null | head -1)"
    if [ -z "$TGZ_PATH" ]; then
      echo "Error: npm pack did not produce a tarball" >&2
      exit 1
    fi
    cp "$TGZ_PATH" "$KILOCLAW_DIR/openclaw-build/"
    rm -f "$TGZ_PATH"
    echo "Copied $(basename "$TGZ_PATH") to openclaw-build/"
  else
    echo "Using existing tarball in openclaw-build/"
  fi
elif [ "$USE_LOCAL" = true ] && [ -n "$OPENCLAW_TAG" ]; then
  echo "Error: --openclaw-tag with --local requires --openclaw PATH" >&2
  exit 1
fi

# ── Select Dockerfile ─────────────────────────────────────────────────
if [ "$USE_LOCAL" = true ]; then
  DOCKERFILE="$KILOCLAW_DIR/Dockerfile.local"
  if ! ls "$KILOCLAW_DIR"/openclaw-build/openclaw-*.tgz 1>/dev/null 2>&1; then
    echo "Error: No openclaw-*.tgz found in openclaw-build/." >&2
    echo "Either pass --openclaw /path/to/openclaw or build manually:" >&2
    echo "  cd /path/to/openclaw && pnpm build && npm pack" >&2
    echo "  cp openclaw-*.tgz $(cd "$KILOCLAW_DIR" && pwd)/openclaw-build/" >&2
    exit 1
  fi
  echo "Using Dockerfile.local (local OpenClaw tarball)"
else
  DOCKERFILE="$KILOCLAW_DIR/Dockerfile"
  if [ -n "$OPENCLAW_TAG" ]; then
    echo "Patching Dockerfile to use openclaw@$OPENCLAW_TAG ..."
    # Create a temp Dockerfile with the overridden version
    DOCKERFILE="$(mktemp)"
    trap 'rm -f "$DOCKERFILE"' EXIT
    sed "s/npm install -g openclaw@[^ ]*/npm install -g openclaw@$OPENCLAW_TAG/" \
      "$KILOCLAW_DIR/Dockerfile" > "$DOCKERFILE"
  fi
fi

# ── Resolve image tag ─────────────────────────────────────────────────
IMAGE=""
if [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
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
