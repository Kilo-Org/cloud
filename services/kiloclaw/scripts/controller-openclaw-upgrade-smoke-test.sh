#!/usr/bin/env bash
set -euo pipefail

# Builds the checked-in KiloClaw images before and after an OpenClaw version bump,
# then runs the live persisted-root upgrade smoke against both images.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$KILOCLAW_DIR/../.." && pwd)"
BASE_REF="${BASE_REF:-origin/main}"
IMAGE_BEFORE="${IMAGE_BEFORE:-kiloclaw:openclaw-upgrade-before}"
IMAGE_AFTER="${IMAGE_AFTER:-kiloclaw:openclaw-upgrade-after}"
ALLOW_SAME_OPENCLAW_VERSION="${ALLOW_SAME_OPENCLAW_VERSION:-false}"
WORKTREE_ROOT=""
WORKTREE_DIR=""

cleanup() {
  if [ -n "$WORKTREE_DIR" ] && [ -d "$WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  if [ -n "$WORKTREE_ROOT" ] && [ -d "$WORKTREE_ROOT" ]; then
    rm -rf "$WORKTREE_ROOT"
  fi
}
trap cleanup EXIT

extract_openclaw_version() {
  python3 -c '
import re
import sys

match = re.search(r"npm install -g[^\n]* openclaw@([0-9]+\.[0-9]+\.[0-9]+)", sys.stdin.read())
if not match:
    raise SystemExit("Unable to extract pinned openclaw version from Dockerfile")
print(match.group(1))
'
}

if ! git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF^{commit}" >/dev/null 2>&1; then
  echo "Unable to resolve BASE_REF '$BASE_REF'. Fetch the base ref or set BASE_REF explicitly." >&2
  exit 1
fi

VERSION_BEFORE=$(git -C "$REPO_ROOT" show "$BASE_REF:services/kiloclaw/Dockerfile" | extract_openclaw_version)
VERSION_AFTER=$(extract_openclaw_version < "$KILOCLAW_DIR/Dockerfile")

if [ "$VERSION_BEFORE" = "$VERSION_AFTER" ] && [ "$ALLOW_SAME_OPENCLAW_VERSION" != "true" ]; then
  echo "No OpenClaw version change detected: both $BASE_REF and the current checkout pin $VERSION_AFTER." >&2
  echo "Run this on an OpenClaw bump branch, or set ALLOW_SAME_OPENCLAW_VERSION=true only to test wrapper mechanics." >&2
  exit 1
fi

echo "OpenClaw upgrade smoke: $VERSION_BEFORE -> $VERSION_AFTER"
echo "Baseline ref: $BASE_REF"
echo "Baseline image: $IMAGE_BEFORE"
echo "Candidate image: $IMAGE_AFTER"

WORKTREE_ROOT=$(mktemp -d)
WORKTREE_DIR="$WORKTREE_ROOT/base"
git -C "$REPO_ROOT" worktree add --detach "$WORKTREE_DIR" "$BASE_REF" >/dev/null

echo
echo "Building baseline image from $BASE_REF ..."
docker buildx build \
  --build-context "workspace=$WORKTREE_DIR" \
  --load \
  --progress=plain \
  -t "$IMAGE_BEFORE" \
  "$WORKTREE_DIR/services/kiloclaw"

echo
echo "Building candidate image from current checkout ..."
docker buildx build \
  --build-context "workspace=$REPO_ROOT" \
  --load \
  --progress=plain \
  -t "$IMAGE_AFTER" \
  "$KILOCLAW_DIR"

echo
echo "Running persisted-root live upgrade smoke ..."
IMAGE_BEFORE="$IMAGE_BEFORE" \
IMAGE_AFTER="$IMAGE_AFTER" \
EXPECTED_VERSION_BEFORE="$VERSION_BEFORE" \
EXPECTED_VERSION_AFTER="$VERSION_AFTER" \
bash "$SCRIPT_DIR/controller-live-provider-smoke-test.sh" --upgrade
