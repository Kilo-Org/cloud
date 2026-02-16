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

echo "Building + pushing $IMAGE (linux/amd64) ..."
docker buildx build \
  --platform linux/amd64 \
  -f "$KILOCLAW_DIR/Dockerfile" \
  -t "$IMAGE" \
  --push \
  "$KILOCLAW_DIR"

# Update .dev.vars
if [ -f "$KILOCLAW_DIR/.dev.vars" ]; then
  if grep -q '^FLY_IMAGE_TAG=' "$KILOCLAW_DIR/.dev.vars"; then
    sed -i '' "s/^FLY_IMAGE_TAG=.*/FLY_IMAGE_TAG=$TAG/" "$KILOCLAW_DIR/.dev.vars"
  else
    echo "FLY_IMAGE_TAG=$TAG" >> "$KILOCLAW_DIR/.dev.vars"
  fi
  echo "Updated .dev.vars: FLY_IMAGE_TAG=$TAG"
else
  echo "No .dev.vars found — set FLY_IMAGE_TAG=$TAG manually"
fi

echo ""
echo "Done. Restart wrangler dev to pick up the new tag."
echo "Then restart your instance from the dashboard (or destroy + re-provision)."
