#!/usr/bin/env bash
# Assert that the kilo-chat plugin's peerDependencies.openclaw matches the
# version installed in services/kiloclaw/Dockerfile. Drift between the two
# means the plugin's runtime API shape can silently diverge from the OpenClaw
# version baked into the Docker image.
set -euo pipefail

DOCKERFILE="services/kiloclaw/Dockerfile"
PLUGIN_PKG="services/kiloclaw/plugins/kilo-chat/package.json"

if [ ! -f "$DOCKERFILE" ] || [ ! -f "$PLUGIN_PKG" ]; then
  echo "check-plugin-openclaw-pin: required files missing" >&2
  exit 1
fi

DOCKERFILE_VERSION=$(grep -Eo 'npm install -g openclaw@[0-9][^[:space:]]*' "$DOCKERFILE" \
  | head -n1 \
  | sed -E 's/.*openclaw@//')

if [ -z "$DOCKERFILE_VERSION" ]; then
  echo "check-plugin-openclaw-pin: could not parse openclaw@VERSION from $DOCKERFILE" >&2
  exit 1
fi

PEER_VERSION=$(node -e "const p=require('./$PLUGIN_PKG'); process.stdout.write(p.peerDependencies && p.peerDependencies.openclaw || '');")

if [ -z "$PEER_VERSION" ]; then
  echo "check-plugin-openclaw-pin: $PLUGIN_PKG peerDependencies.openclaw is missing" >&2
  exit 1
fi

if [ "$DOCKERFILE_VERSION" != "$PEER_VERSION" ]; then
  echo "check-plugin-openclaw-pin: version mismatch" >&2
  echo "  $DOCKERFILE installs openclaw@$DOCKERFILE_VERSION" >&2
  echo "  $PLUGIN_PKG peerDependencies.openclaw = $PEER_VERSION" >&2
  exit 1
fi

echo "check-plugin-openclaw-pin: openclaw pinned at $DOCKERFILE_VERSION in both places."
