#!/usr/bin/env bash
# Assert that every EXACT openclaw pin in the bundled KiloClaw plugins matches the
# version installed in services/kiloclaw/Dockerfile. Drift means a plugin's
# runtime API shape can silently diverge from the OpenClaw version baked into the
# Docker image.
#
# Fail-closed on a known required set (kilo-chat and kiloclaw-morning-briefing,
# peer and dev): each must exist and match. Other bundled plugins are discovered
# and their exact pins checked as supplemental coverage. Non-exact constraints
# (for example the kiloclaw-customizer ">=" floor) are intentionally skipped.
#
# No arguments. Exits non-zero on a missing required pin or any version mismatch.
set -euo pipefail

DOCKERFILE="services/kiloclaw/Dockerfile"
PLUGINS_DIR="services/kiloclaw/plugins"

# Required exact pins that must always exist and match (package.json:field).
REQUIRED=(
  "$PLUGINS_DIR/kilo-chat/package.json:peerDependencies"
  "$PLUGINS_DIR/kilo-chat/package.json:devDependencies"
  "$PLUGINS_DIR/kiloclaw-morning-briefing/package.json:peerDependencies"
  "$PLUGINS_DIR/kiloclaw-morning-briefing/package.json:devDependencies"
)

if [ ! -f "$DOCKERFILE" ]; then
  echo "check-plugin-openclaw-pin: required file missing: $DOCKERFILE" >&2
  exit 1
fi

DOCKERFILE_VERSION=$(grep -Eo 'openclaw@[0-9][^[:space:]]*' "$DOCKERFILE" \
  | head -n1 \
  | sed -E 's/openclaw@//')

if [ -z "$DOCKERFILE_VERSION" ]; then
  echo "check-plugin-openclaw-pin: could not parse openclaw@VERSION from $DOCKERFILE" >&2
  exit 1
fi

read_pin() {
  node -e "const p=require('./$1'); const d=p['$2']||{}; process.stdout.write(d.openclaw||'');"
}

mismatch=0
checked=0

# Required set: must be present and exact and match. Missing or non-exact fails.
for entry in "${REQUIRED[@]}"; do
  pkg="${entry%%:*}"
  field="${entry##*:}"
  if [ ! -f "$pkg" ]; then
    echo "check-plugin-openclaw-pin: required file missing: $pkg" >&2
    mismatch=1
    continue
  fi
  version="$(read_pin "$pkg" "$field")"
  if [ -z "$version" ]; then
    echo "check-plugin-openclaw-pin: required pin missing: $pkg $field.openclaw" >&2
    mismatch=1
    continue
  fi
  case "$version" in
    [0-9]*) ;;
    *)
      echo "check-plugin-openclaw-pin: required pin is not exact: $pkg $field.openclaw = $version" >&2
      mismatch=1
      continue
      ;;
  esac
  checked=$((checked + 1))
  if [ "$version" != "$DOCKERFILE_VERSION" ]; then
    echo "check-plugin-openclaw-pin: version mismatch" >&2
    echo "  $DOCKERFILE installs openclaw@$DOCKERFILE_VERSION" >&2
    echo "  $pkg $field.openclaw = $version" >&2
    mismatch=1
  fi
done

# Supplemental: any other bundled plugin's exact pins. The required plugins are
# already covered above, so skip them here.
for pkg in "$PLUGINS_DIR"/*/package.json; do
  [ -f "$pkg" ] || continue
  case "$pkg" in
    "$PLUGINS_DIR/kilo-chat/package.json" | "$PLUGINS_DIR/kiloclaw-morning-briefing/package.json") continue ;;
  esac
  for field in peerDependencies devDependencies; do
    version="$(read_pin "$pkg" "$field")"
    [ -n "$version" ] || continue
    case "$version" in
      [0-9]*) ;;
      *)
        echo "check-plugin-openclaw-pin: skipping non-exact pin $pkg $field.openclaw = $version" >&2
        continue
        ;;
    esac
    checked=$((checked + 1))
    if [ "$version" != "$DOCKERFILE_VERSION" ]; then
      echo "check-plugin-openclaw-pin: version mismatch" >&2
      echo "  $DOCKERFILE installs openclaw@$DOCKERFILE_VERSION" >&2
      echo "  $pkg $field.openclaw = $version" >&2
      mismatch=1
    fi
  done
done

if [ "$checked" -eq 0 ]; then
  echo "check-plugin-openclaw-pin: no openclaw pins were checked; expected the required set" >&2
  exit 1
fi
if [ "$mismatch" -ne 0 ]; then
  exit 1
fi

echo "check-plugin-openclaw-pin: openclaw pinned at $DOCKERFILE_VERSION across $checked bundled plugin pin(s)."
