#!/usr/bin/env bash
# Assert that every exact openclaw pin in the bundled KiloClaw plugins matches
# the version installed in services/kiloclaw/Dockerfile. Drift means a plugin's
# runtime API shape can silently diverge from the OpenClaw version baked into the
# Docker image.
#
# Checks peerDependencies.openclaw and devDependencies.openclaw for both kilo-chat
# and kiloclaw-morning-briefing. The kiloclaw-customizer plugin intentionally uses
# a ">=" floor rather than an exact pin, so it is not checked here.
#
# No arguments. Exits non-zero on any missing file/field or version mismatch.
set -euo pipefail

DOCKERFILE="services/kiloclaw/Dockerfile"

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

# Each entry is "package.json path:dependency field".
PINS=(
  "services/kiloclaw/plugins/kilo-chat/package.json:peerDependencies"
  "services/kiloclaw/plugins/kilo-chat/package.json:devDependencies"
  "services/kiloclaw/plugins/kiloclaw-morning-briefing/package.json:peerDependencies"
  "services/kiloclaw/plugins/kiloclaw-morning-briefing/package.json:devDependencies"
)

mismatch=0
for entry in "${PINS[@]}"; do
  pkg="${entry%%:*}"
  field="${entry##*:}"

  if [ ! -f "$pkg" ]; then
    echo "check-plugin-openclaw-pin: required file missing: $pkg" >&2
    mismatch=1
    continue
  fi

  version=$(node -e "const p=require('./$pkg'); const d=p['$field']||{}; process.stdout.write(d.openclaw||'');")

  if [ -z "$version" ]; then
    echo "check-plugin-openclaw-pin: $pkg $field.openclaw is missing" >&2
    mismatch=1
    continue
  fi

  if [ "$version" != "$DOCKERFILE_VERSION" ]; then
    echo "check-plugin-openclaw-pin: version mismatch" >&2
    echo "  $DOCKERFILE installs openclaw@$DOCKERFILE_VERSION" >&2
    echo "  $pkg $field.openclaw = $version" >&2
    mismatch=1
  fi
done

if [ "$mismatch" -ne 0 ]; then
  exit 1
fi

echo "check-plugin-openclaw-pin: openclaw pinned at $DOCKERFILE_VERSION across all bundled plugin pins."
