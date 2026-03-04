#!/bin/sh
# Build the Docker image for linux/amd64, push to Fly registry with a
# timestamped tag, and update .dev.vars so the worker uses it on next
# machine create/restart.
#
# Usage: ./scripts/push-dev.sh [app-name]
#   app-name defaults to FLY_APP_NAME from .dev.vars, or "kiloclaw-dev"
#
# Prerequisites: fly auth docker (for registry auth)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"

# Read app name from argument, .dev.vars, or default
APP_NAME="${1:-}"
if [ -z "$APP_NAME" ] && [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
  APP_NAME=$(grep '^FLY_APP_NAME=' "$KILOCLAW_DIR/.dev.vars" | cut -d= -f2)
fi
APP_NAME="${APP_NAME:-kiloclaw-dev}"

TAG="dev-$(date +%s)"
IMAGE="registry.fly.io/$APP_NAME:$TAG"
GIT_SHA="$(git -C "$KILOCLAW_DIR" rev-parse HEAD 2>/dev/null || echo 'unknown')"

echo "Building + pushing $IMAGE (linux/amd64) ..."
echo "Controller commit: $GIT_SHA"

# Use --metadata-file to capture the pushed image digest
METADATA_FILE="$(mktemp)"
trap 'rm -f "$METADATA_FILE"' EXIT

docker buildx build \
  --platform linux/amd64 \
  -f "$KILOCLAW_DIR/Dockerfile" \
  --build-arg "CONTROLLER_COMMIT=$GIT_SHA" \
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
else
  echo "No .dev.vars found — set FLY_IMAGE_TAG=$TAG manually"
fi

echo ""
echo "Done. Restart wrangler dev to pick up the new tag."
echo "Then restart your instance from the dashboard (or destroy + re-provision)."
