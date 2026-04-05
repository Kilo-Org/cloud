#!/bin/sh
# Build the google-setup Docker image for amd64+arm64 and push to GHCR
# with a :dev tag, so local testing uses a separate image from prod (:latest).
#
# Usage: ./push-dev.sh
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="ghcr.io/kilo-org/google-setup"
TAG="dev"

echo "Authenticating with GHCR..."
echo "$(gh auth token)" | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin

echo ""
echo "Building + pushing $IMAGE:$TAG (linux/amd64,linux/arm64) ..."

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t "$IMAGE:$TAG" \
  --push \
  "$SCRIPT_DIR"

echo ""
echo "Pulling latest image locally..."
docker pull "$IMAGE:$TAG"

echo ""
echo "Done. Run with:"
echo "  docker run -it --network host $IMAGE:$TAG --token=\"YOUR_JWT\""
echo ""
echo "For local worker:"
echo "  docker run -it --network host $IMAGE:$TAG --token=\"YOUR_JWT\" --worker-url=http://localhost:8795"
