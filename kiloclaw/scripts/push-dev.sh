#!/bin/sh
# Build the Docker image for linux/amd64, push to Fly registry with a
# timestamped tag, and update .dev.vars so the worker uses it on next
# machine create/restart.
#
# Usage: ./scripts/push-dev.sh [--local] [app-name]
#   --local    Use Dockerfile.local to install OpenClaw from a local tarball
#              in openclaw-build/ instead of npm. Build your fork first:
#              cd /path/to/openclaw && pnpm build && npm pack
#              cp openclaw-*.tgz /path/to/kiloclaw/openclaw-build/
#   app-name   defaults to FLY_APP_NAME from .dev.vars, or "kiloclaw-dev"
#
set -e

# Fly registry tokens expire after 5 minutes, so re-auth on every push.
echo "Authenticating with Fly registry..."
fly auth docker

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"

# Parse --local flag
USE_LOCAL=false
for arg in "$@"; do
  case "$arg" in
    --local) USE_LOCAL=true; shift ;;
  esac
done

# Select Dockerfile
if [ "$USE_LOCAL" = true ]; then
  DOCKERFILE="$KILOCLAW_DIR/Dockerfile.local"
  # Validate that a tarball exists in openclaw-build/
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

# Read registry app name from argument, .dev.vars, or default.
# FLY_REGISTRY_APP is the shared app that hosts Docker images in the Fly
# registry.  FLY_APP_NAME is a legacy fallback (in production these differ:
# FLY_REGISTRY_APP=kiloclaw-machines vs per-user apps for routing).
APP_NAME="${1:-}"
if [ -z "$APP_NAME" ] && [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
  APP_NAME=$(grep '^FLY_REGISTRY_APP=' "$KILOCLAW_DIR/.dev.vars" | cut -d= -f2)
fi
if [ -z "$APP_NAME" ] && [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
  APP_NAME=$(grep '^FLY_APP_NAME=' "$KILOCLAW_DIR/.dev.vars" | cut -d= -f2)
fi
APP_NAME="${APP_NAME:-kiloclaw-registry-dev}"

TAG="dev-$(date +%s)"
IMAGE="registry.fly.io/$APP_NAME:$TAG"
GIT_SHA="$(git -C "$KILOCLAW_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')"

# Extract OpenClaw version from Dockerfile (only available when using npm install)
OPENCLAW_VERSION=$(sed -n 's/.*openclaw@\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' "$KILOCLAW_DIR/Dockerfile" | head -1)

echo "Building + pushing $IMAGE (linux/amd64) ..."
echo "Controller commit: $GIT_SHA"

# Use --metadata-file to capture the pushed image digest
METADATA_FILE="$(mktemp)"
trap 'rm -f "$METADATA_FILE"' EXIT

docker buildx build \
  --platform linux/amd64 \
  -f "$DOCKERFILE" \
  --build-arg "CONTROLLER_COMMIT=$GIT_SHA" \
  --build-arg "CONTROLLER_CACHE_BUST=$(date +%s)" \
  -t "$IMAGE" \
  --push \
  --metadata-file "$METADATA_FILE" \
  "$KILOCLAW_DIR"

# Extract digest from build metadata
DIGEST=""
if [ -f "$METADATA_FILE" ] && command -v jq >/dev/null 2>&1; then
  DIGEST=$(jq -r '.["containerimage.digest"] // empty' "$METADATA_FILE" 2>/dev/null)
fi

# Update .dev.vars
if [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
  if grep -q '^FLY_IMAGE_TAG=' "$KILOCLAW_DIR/.dev.vars"; then
    # Use temp file for cross-platform sed compatibility (macOS/Linux)
    sed "s/^FLY_IMAGE_TAG=.*/FLY_IMAGE_TAG=$TAG/" "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
    mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
  else
    echo "FLY_IMAGE_TAG=$TAG" >> "$KILOCLAW_DIR/.dev.vars"
  fi

  if [ -n "$DIGEST" ]; then
    if grep -q '^FLY_IMAGE_DIGEST=' "$KILOCLAW_DIR/.dev.vars"; then
      # Use temp file for cross-platform sed compatibility (macOS/Linux)
      sed "s|^FLY_IMAGE_DIGEST=.*|FLY_IMAGE_DIGEST=$DIGEST|" "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
      mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
    else
      echo "FLY_IMAGE_DIGEST=$DIGEST" >> "$KILOCLAW_DIR/.dev.vars"
    fi
    echo "Updated .dev.vars: FLY_IMAGE_TAG=$TAG  FLY_IMAGE_DIGEST=$DIGEST"
  else
    echo "Updated .dev.vars: FLY_IMAGE_TAG=$TAG  (digest not captured)"
  fi

  if [ -n "$OPENCLAW_VERSION" ]; then
    if grep -q '^OPENCLAW_VERSION=' "$KILOCLAW_DIR/.dev.vars"; then
      sed "s/^OPENCLAW_VERSION=.*/OPENCLAW_VERSION=$OPENCLAW_VERSION/" "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
      mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
    else
      echo "OPENCLAW_VERSION=$OPENCLAW_VERSION" >> "$KILOCLAW_DIR/.dev.vars"
    fi
    echo "Updated .dev.vars: OPENCLAW_VERSION=$OPENCLAW_VERSION"
  fi
else
  echo "No .dev.vars found — set FLY_IMAGE_TAG=$TAG manually"
fi

# ---------- Store content hash of image sources ----------
# Mirrors the find list used in deploy-kiloclaw.yml and dev-start.sh.

# Resolve sha command once (xargs can't invoke shell functions).
if command -v sha256sum >/dev/null 2>&1; then
  _SHA="sha256sum"
else
  _SHA="shasum -a 256"
fi

CONTENT_HASH=$(
  cd "$KILOCLAW_DIR" \
  && find Dockerfile controller/ container/ skills/ \
       openclaw-pairing-list.js openclaw-device-pairing-list.js \
       -type f 2>/dev/null \
  | sort \
  | xargs $_SHA \
  | $_SHA \
  | cut -d' ' -f1 \
  | cut -c1-12
)

if [ -f "$KILOCLAW_DIR/.dev.vars" ] && [ -n "$CONTENT_HASH" ]; then
  if grep -q '^FLY_IMAGE_CONTENT_HASH=' "$KILOCLAW_DIR/.dev.vars"; then
    sed "s/^FLY_IMAGE_CONTENT_HASH=.*/FLY_IMAGE_CONTENT_HASH=$CONTENT_HASH/" \
      "$KILOCLAW_DIR/.dev.vars" > "$KILOCLAW_DIR/.dev.vars.tmp"
    mv "$KILOCLAW_DIR/.dev.vars.tmp" "$KILOCLAW_DIR/.dev.vars"
  else
    echo "FLY_IMAGE_CONTENT_HASH=$CONTENT_HASH" >> "$KILOCLAW_DIR/.dev.vars"
  fi
fi

echo ""
echo "FLY_IMAGE_TAG=$TAG"
if [ -n "$DIGEST" ]; then
  echo "FLY_IMAGE_DIGEST=$DIGEST"
fi
if [ -n "$OPENCLAW_VERSION" ]; then
  echo "OPENCLAW_VERSION=$OPENCLAW_VERSION"
fi
if [ -n "$CONTENT_HASH" ]; then
  echo "FLY_IMAGE_CONTENT_HASH=$CONTENT_HASH"
fi
echo ""
echo "Done. Restart wrangler dev to pick up the new tag."
echo "Then restart your instance from the dashboard (or destroy + re-provision)."
