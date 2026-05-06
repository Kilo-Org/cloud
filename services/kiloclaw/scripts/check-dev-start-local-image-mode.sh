#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE_SCRIPT="$SCRIPT_DIR/dev-image-mode.sh"

if [ ! -f "$MODE_SCRIPT" ]; then
  echo "Expected $MODE_SCRIPT to exist" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/scripts" "$TMP_DIR/openclaw-build"
LOCAL_TARBALL="$TMP_DIR/openclaw-build/openclaw-dev-start-check.tgz"
printf 'local openclaw package\n' > "$LOCAL_TARBALL"
printf 'FLY_IMAGE_CONTENT_HASH=localhash\n' > "$TMP_DIR/.dev.vars"

cat > "$TMP_DIR/scripts/image-content-hash.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$KILOCLAW_HASH_CALLS"

case "$*" in
  *"--dockerfile Dockerfile.local"*"--openclaw-tarball "*)
    printf 'localhash\n'
    ;;
  *"--dockerfile Dockerfile"*)
    printf 'prodhash\n'
    ;;
  *)
    echo "Unexpected image-content-hash args: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$TMP_DIR/scripts/image-content-hash.sh"

export KILOCLAW_HASH_CALLS="$TMP_DIR/hash.calls"

# shellcheck source=/dev/null
source "$MODE_SCRIPT"

PLAN="$(kiloclaw_dev_image_plan "$TMP_DIR" "")"
MODE="$(printf '%s\n' "$PLAN" | sed -n '1p')"
HASH="$(printf '%s\n' "$PLAN" | sed -n '2p')"
TARBALL="$(printf '%s\n' "$PLAN" | sed -n '3p')"
INFERRED="$(printf '%s\n' "$PLAN" | sed -n '4p')"

if [ "$MODE" != "local" ]; then
  echo "Expected legacy local hash to preserve local image mode, got: $MODE" >&2
  exit 1
fi
if [ "$HASH" != "localhash" ]; then
  echo "Expected local hash, got: $HASH" >&2
  exit 1
fi
if [ "$TARBALL" != "$LOCAL_TARBALL" ]; then
  echo "Expected selected tarball $LOCAL_TARBALL, got: $TARBALL" >&2
  exit 1
fi
if [ "$INFERRED" != "true" ]; then
  echo "Expected legacy local mode to be inferred" >&2
  exit 1
fi
if ! grep -q -- "--dockerfile Dockerfile.local --openclaw-tarball $LOCAL_TARBALL" "$KILOCLAW_HASH_CALLS"; then
  echo "Expected dev-start image planning to hash Dockerfile.local with the selected tarball" >&2
  exit 1
fi
if ! grep -q -- 'push-dev.sh" "${PUSH_DEV_ARGS\[@\]}"' "$SCRIPT_DIR/dev-start.sh"; then
  echo "Expected dev-start.sh to call push-dev.sh through PUSH_DEV_ARGS" >&2
  exit 1
fi
if ! grep -q -- 'PUSH_DEV_ARGS+=(--local)' "$SCRIPT_DIR/dev-start.sh"; then
  echo "Expected dev-start.sh to pass --local for local image mode" >&2
  exit 1
fi

echo "dev-start local image mode preserves local hash inputs and push mode"
