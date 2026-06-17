#!/usr/bin/env bash
set -euo pipefail

# Keyless CI verification for a KiloClaw OpenClaw bump.
#
# Runs every upgrade check that does NOT require a live Kilo API key, so it is
# safe to run automatically on a public repo: it never loads a credential into
# the (freshly released, untrusted) OpenClaw, so there is nothing to exfiltrate.
# It builds the candidate production-pin image (which proves the Dockerfile
# bundle-patch guards still match — they `exit 1` on mismatch), checks the
# version, the applied patches, the bundled plugins, and runs `openclaw config
# validate` against representative app-written config shapes (the validator runs
# without starting the gateway, so no key is needed).
#
# The credentialed live smoke — controller-openclaw-upgrade-smoke-test.sh — is a
# DEVELOPER step, not CI. This script prints exactly what still must be run with
# credentials, so the PR records both what was automated and what is left.
#
# Env:
#   IMAGE   image tag to build/use (default kiloclaw:openclaw-upgrade-verify)
#   BUILD   build the candidate image first (default true; set false to reuse IMAGE)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KILOCLAW_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$KILOCLAW_DIR/../.." && pwd)"
IMAGE="${IMAGE:-kiloclaw:openclaw-upgrade-verify}"
BUILD="${BUILD:-true}"
BUILD_LOG="$(mktemp)"
PASS=0
FAIL=0

cleanup() { rm -f "$BUILD_LOG"; }
trap cleanup EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

extract_pinned_version() {
  grep -oE 'openclaw@[0-9]+\.[0-9]+\.[0-9]+' "$KILOCLAW_DIR/Dockerfile" | head -1 | cut -d'@' -f2
}

# Runs `openclaw config validate` (keyless) against a fixture config and checks
# whether the packaged OpenClaw accepts/rejects it as expected.
validate_fixture() {
  local label="$1" cfg="$2" expect="$3"
  local out res
  out=$(docker run --rm -e OPENCLAW_CONFIG_PATH=/tmp/cfg.json "$IMAGE" \
    sh -c "printf '%s' '$cfg' > /tmp/cfg.json && openclaw config validate --json" 2>/dev/null || true)
  res=$(printf '%s' "$out" | python3 -c '
import json
import sys

try:
    print("valid" if json.load(sys.stdin).get("valid") is True else "invalid")
except Exception:
    print("error")
')
  check "$label" "$expect" "$res"
}

EXPECTED_VERSION="$(extract_pinned_version)"
if [ -z "$EXPECTED_VERSION" ]; then
  echo "Unable to read the openclaw pin from $KILOCLAW_DIR/Dockerfile" >&2
  exit 1
fi

echo "Keyless OpenClaw upgrade verification for openclaw@$EXPECTED_VERSION"
echo "Image: $IMAGE"
echo

if [ "$BUILD" = "true" ]; then
  echo "Building candidate image (proves Dockerfile bundle-patch guards match) ..."
  if docker buildx build \
      --build-context "workspace=$REPO_ROOT" \
      --load \
      -t "$IMAGE" \
      "$KILOCLAW_DIR" > "$BUILD_LOG" 2>&1; then
    check "candidate image builds (patch guards match)" "ok" "ok"
  else
    check "candidate image builds (patch guards match)" "ok" "failed"
    echo "  build failed; last lines:"
    tail -n 30 "$BUILD_LOG" | sed 's/^/    /'
    echo
    echo "=== Keyless verification: $PASS passed, $FAIL failed ==="
    exit 1
  fi
fi

# ── Version + applied bundle patches ─────────────────────────────────────────
version=$(docker run --rm "$IMAGE" openclaw --version 2>/dev/null \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
check "openclaw version" "$EXPECTED_VERSION" "$version"

timeout_patch=$(docker run --rm "$IMAGE" sh -c \
  'OC=/usr/local/lib/node_modules/openclaw/dist; F=$(grep -l KILOCODE_MODELS_URL $OC/provider-models-*.js); grep -c "DISCOVERY_TIMEOUT_MS = 60e3" "$F"' 2>/dev/null || echo 0)
check "model-discovery timeout patch applied (60e3)" "1" "$timeout_patch"

action_patch=$(docker run --rm "$IMAGE" sh -c \
  'OC=/usr/local/lib/node_modules/openclaw/dist; F=$(find $OC -name "channel-target-*.js" | head -1); grep -c "MESSAGE_ACTION_TARGET_MODE\[action\] ?? \"none\"" "$F"' 2>/dev/null || echo 0)
check "actionRequiresTarget patch applied" "1" "$action_patch"

# ── Bundled plugins pin alignment ────────────────────────────────────────────
kc_peer=$(docker run --rm "$IMAGE" \
  node -p "require('/usr/local/lib/node_modules/@kiloclaw/kilo-chat/package.json').peerDependencies.openclaw" 2>/dev/null || echo "")
check "kilo-chat plugin peer matches pin" "$EXPECTED_VERSION" "$kc_peer"

mb_peer=$(docker run --rm "$IMAGE" \
  node -p "require('/usr/local/lib/node_modules/@kiloclaw/kiloclaw-morning-briefing/package.json').peerDependencies.openclaw" 2>/dev/null || echo "")
check "morning-briefing plugin peer matches pin" "$EXPECTED_VERSION" "$mb_peer"

# ── Keyless config schema validation (no gateway) ────────────────────────────
# Representative app-written shapes must still validate against the packaged
# OpenClaw schema; a malformed config must still be rejected (validator sanity).
validate_fixture "app config shape validates (model override + exec policy)" \
  '{"agents":{"defaults":{"model":{"primary":"kilocode/kilo-auto/free"}}},"tools":{"exec":{"security":"allowlist","ask":"on-miss"}}}' \
  "valid"
validate_fixture "agent-defaults model+fallbacks shape validates" \
  '{"agents":{"defaults":{"model":{"primary":"kilocode/kilo-auto/free","fallbacks":[]}}}}' \
  "valid"
validate_fixture "validator still rejects a malformed config (self-check)" \
  '{"agents":{"defaults":{"model":{"primary":123}}}}' \
  "invalid"

echo
echo "=== Keyless verification: $PASS passed, $FAIL failed ==="

cat <<EOF

----------------------------------------------------------------------
This CI run covered only checks that need NO Kilo API key. Before merge,
a developer MUST run the credentialed live smoke locally (it loads a real
key into the container, so it is not run in CI):

  export KILOCODE_API_KEY=<dedicated free-model key>   # not your personal key
  bash services/kiloclaw/scripts/controller-openclaw-upgrade-smoke-test.sh

That covers what CI cannot without a credential:
  - persisted-root upgrade boot (baseline -> candidate on the same /root)
  - gateway readiness + proxied Control UI
  - kilo-chat plugin load, diagnostics, and webhook route
  - app config-write routes (/_kilo/config/patch, agent-defaults, agents CRUD)
  - exec-approvals seeding
  - a real Auto Free agent turn through the live Kilo Gateway
----------------------------------------------------------------------
EOF

[ "$FAIL" -gt 0 ] && exit 1
exit 0
