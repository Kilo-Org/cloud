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
ALLOW_DIRTY_CHECKOUT="${ALLOW_DIRTY_CHECKOUT:-false}"
WORKTREE_ROOT=""
BASE_WORKTREE_DIR=""
CANDIDATE_WORKTREE_DIR=""

cleanup() {
  if [ -n "$CANDIDATE_WORKTREE_DIR" ] && [ -d "$CANDIDATE_WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$CANDIDATE_WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  if [ -n "$BASE_WORKTREE_DIR" ] && [ -d "$BASE_WORKTREE_DIR" ]; then
    git -C "$REPO_ROOT" worktree remove --force "$BASE_WORKTREE_DIR" >/dev/null 2>&1 || true
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

if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]; then
  if [ "$ALLOW_DIRTY_CHECKOUT" != "true" ]; then
    echo "The current checkout has uncommitted files; refusing to build a candidate that is not checked in." >&2
    echo "Use a clean OpenClaw bump branch, or set ALLOW_DIRTY_CHECKOUT=true only for local experimentation." >&2
    exit 1
  fi
  echo "WARNING: ALLOW_DIRTY_CHECKOUT=true; running an uncommitted wrapper while the candidate image still builds from HEAD." >&2
fi

if [ "$BASE_REF" = "origin/main" ]; then
  echo "Refreshing baseline ref origin/main ..."
  git -C "$REPO_ROOT" fetch origin main
fi

if ! git -C "$REPO_ROOT" rev-parse --verify "$BASE_REF^{commit}" >/dev/null 2>&1; then
  echo "Unable to resolve BASE_REF '$BASE_REF'. Fetch the base ref or set BASE_REF explicitly." >&2
  exit 1
fi

VERSION_BEFORE=$(git -C "$REPO_ROOT" show "$BASE_REF:services/kiloclaw/Dockerfile" | extract_openclaw_version)
VERSION_AFTER=$(git -C "$REPO_ROOT" show "HEAD:services/kiloclaw/Dockerfile" | extract_openclaw_version)

if [ "$VERSION_BEFORE" = "$VERSION_AFTER" ] && [ "$ALLOW_SAME_OPENCLAW_VERSION" != "true" ]; then
  echo "No OpenClaw version change detected: both $BASE_REF and committed HEAD pin $VERSION_AFTER." >&2
  echo "Run this on an OpenClaw bump branch, or set ALLOW_SAME_OPENCLAW_VERSION=true only to test wrapper mechanics." >&2
  exit 1
fi

echo "OpenClaw upgrade smoke: $VERSION_BEFORE -> $VERSION_AFTER"
echo "Baseline ref: $BASE_REF"
echo "Baseline image: $IMAGE_BEFORE"
echo "Candidate image: $IMAGE_AFTER"

WORKTREE_ROOT=$(mktemp -d)
BASE_WORKTREE_DIR="$WORKTREE_ROOT/base"
CANDIDATE_WORKTREE_DIR="$WORKTREE_ROOT/candidate"
git -C "$REPO_ROOT" worktree add --detach "$BASE_WORKTREE_DIR" "$BASE_REF" >/dev/null
git -C "$REPO_ROOT" worktree add --detach "$CANDIDATE_WORKTREE_DIR" HEAD >/dev/null

echo
echo "Building baseline image from $BASE_REF ..."
docker buildx build \
  --build-context "workspace=$BASE_WORKTREE_DIR" \
  --load \
  --progress=plain \
  -t "$IMAGE_BEFORE" \
  "$BASE_WORKTREE_DIR/services/kiloclaw"

echo
echo "Building candidate image from HEAD ..."
docker buildx build \
  --build-context "workspace=$CANDIDATE_WORKTREE_DIR" \
  --load \
  --progress=plain \
  -t "$IMAGE_AFTER" \
  "$CANDIDATE_WORKTREE_DIR/services/kiloclaw"

echo
echo "Running persisted-root live upgrade smoke ..."
IMAGE_BEFORE="$IMAGE_BEFORE" \
IMAGE_AFTER="$IMAGE_AFTER" \
EXPECTED_VERSION_BEFORE="$VERSION_BEFORE" \
EXPECTED_VERSION_AFTER="$VERSION_AFTER" \
bash "$SCRIPT_DIR/controller-live-provider-smoke-test.sh" --upgrade
