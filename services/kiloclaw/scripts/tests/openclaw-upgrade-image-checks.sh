#!/usr/bin/env bash
set -euo pipefail

# Keyless local verification for a KiloClaw OpenClaw bump (developer tool).
#
# OpenClaw is deliberately never built or executed in CI: it is a freshly
# released, security-sensitive upstream, so every path that runs it is human-
# gated (see the dispatch-only deploy workflows). This is the fast pre-check a
# developer runs locally before the credentialed smoke; it needs no Kilo API
# key, so it can run anywhere.
#
# It builds the candidate production-pin image (which proves the Dockerfile
# bundle-patch guards still match — they `exit 1` on mismatch), checks the
# version, the applied patches, the bundled plugins, runs `openclaw config
# validate` against representative app-written config shapes (the validator runs
# without starting the gateway, so no key is needed), runs `openclaw doctor`
# against the controller's plugin-load set to prove every plugins.load.paths
# entry actually resolves in the image (config validate is schema-only and does
# not — this is the check that catches a controller/runtime plugin-path skew),
# and runs a full grype CVE scan of the image (base OS + Go + npm, unfiltered).
#
# Run the credentialed live smoke (openclaw-upgrade-smoke.sh) next; this script
# prints exactly what that still covers.
#
# Env:
#   IMAGE   image tag to build/use (default kiloclaw:openclaw-upgrade-candidate)
#   BUILD   build the candidate image first (default true; set false to reuse IMAGE)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KILOCLAW_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$KILOCLAW_DIR/../.." && pwd)"
IMAGE="${IMAGE:-kiloclaw:openclaw-upgrade-candidate}"
BUILD="${BUILD:-true}"
# Empty = report the CVE scan but do not change the exit code. Set to
# critical|high to also fail the run when findings at/above that severity exist.
GRYPE_FAIL_ON="${GRYPE_FAIL_ON:-}"
CVE_REPORT="${TMPDIR:-/tmp}/openclaw-cve-report.txt"
BUILD_LOG="$(mktemp)"
PASS=0
FAIL=0
CVE_GATE_FAILED=0

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

# Runs `openclaw doctor` (keyless) against a config and classifies the result by
# whether the plugin paths in plugins.load.paths RESOLVE in the image. This is a
# deeper check than validate_fixture: `openclaw config validate` is schema-only
# and returns valid for a plugins.load.paths entry that does not exist on disk,
# whereas doctor — the exact command the controller runs at boot — fails with
# "plugin path not found". That failure is what bricks an instance (config
# validation fails -> doctor fails -> gateway never starts), so it is the failure
# this check exists to catch.
#   ok               -> doctor accepted the config (all plugin paths resolved)
#   plugin-path-error-> a plugins.load.paths entry did not exist in the image
#   doctor-error     -> doctor failed for some other reason
#
# $cfg is interpolated into a single-quoted `printf '%s' '$cfg'` inside sh -c, so
# it MUST stay a script-internal JSON literal with no single quotes and never
# take arbitrary/external input; a single quote in $cfg would break the quoting.
doctor_plugin_result() {
  local cfg="$1"
  local out rc
  out=$(docker run --rm -e OPENCLAW_CONFIG_PATH=/tmp/cfg.json "$IMAGE" \
    sh -c "printf '%s' '$cfg' > /tmp/cfg.json && openclaw doctor --fix --non-interactive" 2>&1) && rc=0 || rc=$?
  if printf '%s' "$out" | grep -qi "plugin path not found"; then
    echo "plugin-path-error"
  elif [ "$rc" -eq 0 ]; then
    echo "ok"
  else
    echo "doctor-error"
  fi
}

# Full CVE scan of the built image with grype. Nothing is filtered or scoped:
# base-OS, Go, and npm findings are all shown, because a vulnerable base image or
# bundled tool is itself the signal (often "bump the base image / tooling"). The
# digest prints real, unfiltered severity counts and where they live; the full
# per-finding report is written to a file. Informational by default; set
# GRYPE_FAIL_ON=critical|high to also gate the run.
scan_image_cves() {
  echo
  echo "--- image CVE scan (grype, full image — base OS + Go + npm) ---"
  if ! command -v grype >/dev/null 2>&1; then
    echo "SKIP: grype not installed — https://github.com/anchore/grype (e.g. brew install grype)"
    return 0
  fi

  local json db_built
  json="$(mktemp)"

  # Force the vulnerability DB to the latest before scanning, rather than relying
  # on grype's implicit refresh — a security scan should use current data. If the
  # update fails (e.g. offline), fall back to the existing DB and say so.
  echo "Updating grype vulnerability database ..."
  if grype db update -q >/dev/null 2>&1; then
    db_built=$(grype db status 2>/dev/null | awk '/^Built:/{print $2; exit}')
    echo "  DB updated (built: ${db_built:-unknown})"
  else
    db_built=$(grype db status 2>/dev/null | awk '/^Built:/{print $2; exit}')
    echo "  WARN: grype db update failed — scanning against the existing DB (built: ${db_built:-unknown})"
  fi

  echo "Scanning $IMAGE (full image — base OS + Go + npm) ..."
  if ! grype "$IMAGE" -o "table=$CVE_REPORT" -o "json=$json" -q >/dev/null 2>&1; then
    # grype is installed but the scan itself failed (scanner error or image not
    # accessible). The advertised CVE check did not run, so this is a failure —
    # NOT a clean pass. ("grype not installed" above is an explicit skip.)
    echo "FAIL: grype CVE scan did not run (scanner error or image access failure) — CVE posture unknown"
    CVE_GATE_FAILED=1
    rm -f "$json"
    return 0
  fi

  # Print the honest, unfiltered digest. Exit non-zero only if a gate is set and
  # breached, so the scan can fail the run on demand without hiding anything.
  if python3 - "$json" "$GRYPE_FAIL_ON" <<'PY'
import json
import sys
from collections import Counter

doc = json.load(open(sys.argv[1]))
gate = (sys.argv[2] or "").strip().lower()
sev = Counter()
by_type = Counter()
by_pkg = Counter()
for m in doc.get("matches", []):
    s = m.get("vulnerability", {}).get("severity") or "Unknown"
    a = m.get("artifact", {})
    sev[s] += 1
    if s in ("Critical", "High"):
        by_type[a.get("type", "?")] += 1
        by_pkg[f'{a.get("name", "?")} {a.get("version", "?")}'] += 1

order = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"]
print("  severity:  " + "   ".join(f"{k}={sev.get(k, 0)}" for k in order)
      + f"   total={sum(sev.values())}")
if by_type:
    print("  Critical+High by package type: "
          + ", ".join(f"{t}={n}" for t, n in sorted(by_type.items(), key=lambda x: -x[1])))
    print("  top Critical/High packages (a base-image/tooling bump may clear many at once):")
    for pkg, n in by_pkg.most_common(12):
        print(f"    {n:>3}  {pkg}")

crit = sev.get("Critical", 0)
high = sev.get("High", 0)
fail = (gate == "critical" and crit > 0) or (gate == "high" and (crit > 0 or high > 0))
sys.exit(1 if fail else 0)
PY
  then
    gate_breached=0
  else
    gate_breached=1
  fi

  echo "  full findings (all severities): $CVE_REPORT"
  if [ -n "$GRYPE_FAIL_ON" ]; then
    if [ "$gate_breached" -eq 1 ]; then
      echo "  CVE gate: FAIL (GRYPE_FAIL_ON=$GRYPE_FAIL_ON)"
      CVE_GATE_FAILED=1
    else
      echo "  CVE gate: ok (GRYPE_FAIL_ON=$GRYPE_FAIL_ON)"
    fi
  else
    echo "  (informational — review the findings above; set GRYPE_FAIL_ON=critical|high to gate)"
  fi
  rm -f "$json"
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

# KiloCode provider was externalized to @openclaw/kilocode-provider (openclaw #93470, 2026.6.9);
# the patched provider-models bundle is a single non-hashed file in that package.
timeout_patch=$(docker run --rm "$IMAGE" sh -c \
  'F=/usr/local/lib/node_modules/@openclaw/kilocode-provider/dist/provider-models.js; grep -c "DISCOVERY_TIMEOUT_MS = 60e3" "$F"' 2>/dev/null || echo 0)
check "model-discovery timeout patch applied (60e3)" "1" "$timeout_patch"

action_patch=$(docker run --rm "$IMAGE" sh -c \
  'OC=/usr/local/lib/node_modules/openclaw/dist; F=$(find $OC -name "channel-target-*.js" | head -1); grep -c "MESSAGE_ACTION_TARGET_MODE\[action\] ?? \"none\"" "$F"' 2>/dev/null || echo 0)
check "actionRequiresTarget patch applied" "1" "$action_patch"

# ── Externalized kilocode provider pin alignment ─────────────────────────────
# The kilocode provider was externalized from openclaw core (openclaw #93470) and
# is installed as a separate pin (@openclaw/kilocode-provider@<ver>). It is kept
# in lockstep with the openclaw pin; assert the installed version matches so a
# stale or drifted provider pin fails the build.
kcp_version=$(docker run --rm "$IMAGE" \
  node -p "require('/usr/local/lib/node_modules/@openclaw/kilocode-provider/package.json').version" 2>/dev/null || echo "")
check "@openclaw/kilocode-provider matches openclaw pin" "$EXPECTED_VERSION" "$kcp_version"

# ── Bundled plugins pin alignment ────────────────────────────────────────────
kc_peer=$(docker run --rm "$IMAGE" \
  node -p "require('/usr/local/lib/node_modules/@kiloclaw/kilo-chat/package.json').peerDependencies.openclaw" 2>/dev/null || echo "")
check "kilo-chat plugin peer matches pin" "$EXPECTED_VERSION" "$kc_peer"

mb_peer=$(docker run --rm "$IMAGE" \
  node -p "require('/usr/local/lib/node_modules/@kiloclaw/kiloclaw-morning-briefing/package.json').peerDependencies.openclaw" 2>/dev/null || echo "")
check "morning-briefing plugin peer matches pin" "$EXPECTED_VERSION" "$mb_peer"

# ── Bundled CLI tool pins ────────────────────────────────────────────────────
# @steipete/summarize is pinned in the Dockerfile (bumped to 0.15.1 to clear
# GHSA-8jr4-6r33-phwm et al.). Guard both that the pin installed as expected and
# that the CLI still launches, since the smoke does not otherwise exercise it.
# Keep EXPECTED_SUMMARIZE_VERSION in lockstep with the Dockerfile pin.
EXPECTED_SUMMARIZE_VERSION="0.15.1"
summarize_version=$(docker run --rm "$IMAGE" \
  node -p "require('/usr/local/lib/node_modules/@steipete/summarize/package.json').version" 2>/dev/null || echo "")
check "@steipete/summarize pin installed" "$EXPECTED_SUMMARIZE_VERSION" "$summarize_version"

summarize_cli=$(docker run --rm "$IMAGE" sh -c 'summarize --version >/dev/null 2>&1 && echo ok || echo fail')
check "@steipete/summarize CLI launches" "ok" "$summarize_cli"

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

# ── Hook boot-validation parity (drift guard) ────────────────────────────────
# The controller mirrors OpenClaw's resolveHooksConfig so it can (a) refuse
# writes that would leave the gateway unable to start and (b) repair a persisted
# config before each spawn — see hookConfigBootViolation / ensureBootableHookConfig
# in controller/src/config-writer.ts.
#
# That mirror is duplicated logic against a fast-moving upstream, and nothing
# else catches drift: these failures are thrown at gateway startup, NOT by
# `config validate` (schema-only) or `doctor`. A config that trips one of them
# crash-loops the instance with no self-recovery, which is how this class of bug
# reached production in the first place.
#
# So assert the packaged conditions are exactly the set the controller mirrors.
# A new or reworded condition fails here, on the bump PR, rather than silently
# leaving the mirror incomplete. Verified identical on 2026.6.11 and 2026.7.2.
#
# Matches on the throw SITES (`throw new Error("hooks.…"`) rather than on the
# wording of each message. Matching wording would silently pass when upstream
# adds a condition phrased in a way the pattern does not recognise — the pattern
# extracts nothing for it, so nothing differs from the expected list, so the
# guard reports PASS while the mirror is already behind. Anchoring on the throw
# site means any new hooks.* condition changes the extracted set no matter how it
# is worded. Extraction returning nothing fails loudly for the same reason.
#
# Single-quoted, and passed into the container by environment rather than
# interpolated into a nested `sh -c` string: the pattern contains a double quote,
# which would otherwise unbalance the inner command and make it a syntax error
# that `|| echo ""` silently turns into "no conditions found".
#
# If this fails: update the mirror in config-writer.ts (detector AND repair) and
# its tests, then update the expected list below.
HOOK_THROW_PATTERN='throw new Error\("hooks\.[^"]*"'
EXPECTED_HOOK_CONDITIONS="hooks.allowedSessionKeyPrefixes is required when a hook mapping sessionKey uses templates, even if hooks.allowRequestSessionKey=true
hooks.allowedSessionKeyPrefixes must include 'hook:' when hooks.defaultSessionKey is unset
hooks.defaultSessionKey must match hooks.allowedSessionKeyPrefixes
hooks.enabled requires hooks.token
hooks.path may not be '/'"

actual_hook_conditions=$(docker run --rm \
  -e HOOK_THROW_PATTERN="$HOOK_THROW_PATTERN" \
  "$IMAGE" sh -c \
  'grep -rhoE "$HOOK_THROW_PATTERN" /usr/local/lib/node_modules/openclaw/dist/ | sed "s/^throw new Error(\"//; s/\"$//" | sort -u' \
  2>/dev/null || echo "")

expected_hook_count=$(printf '%s\n' "$EXPECTED_HOOK_CONDITIONS" | wc -l | tr -d ' ')
# `|| true`, not `|| echo 0`: grep -c already prints 0 when nothing matches, and
# exits 1 while doing so, so the echo would append a second line and make the
# count "0\n0" — which compares unequal to "0" and defeats the guard below.
actual_hook_count=$(printf '%s\n' "$actual_hook_conditions" | grep -c . || true)
check "hook boot-validation condition count" "$expected_hook_count" "$actual_hook_count"

# Distinguish "extraction broke" from "upstream changed a condition": a zero
# count means the grep found no throw sites at all, which is a bug in this check
# (or a minifier change), not evidence that OpenClaw dropped hook validation.
if [ "$actual_hook_count" = "0" ]; then
  echo "FAIL: extracted no hook conditions from the image — this check is broken, not upstream"
  echo "      verify: docker run --rm $IMAGE sh -c 'ls /usr/local/lib/node_modules/openclaw/dist/ | head'"
  FAIL=$((FAIL + 1))
elif [ "$actual_hook_conditions" = "$EXPECTED_HOOK_CONDITIONS" ]; then
  echo "PASS: hook boot-validation conditions match the controller mirror"
  PASS=$((PASS + 1))
else
  echo "FAIL: hook boot-validation conditions drifted from the controller mirror"
  echo "      controller/src/config-writer.ts must be updated to match. Diff:"
  diff <(printf '%s\n' "$EXPECTED_HOOK_CONDITIONS") <(printf '%s\n' "$actual_hook_conditions") \
    | sed 's/^/      /' || true
  FAIL=$((FAIL + 1))
fi

# ── Keyless plugin-load resolution (doctor, no gateway) ──────────────────────
# Regression guard for the class of bug where the controller writes a
# plugins.load.paths entry that the bundled openclaw does not ship — e.g. the
# externalized @openclaw/kilocode-provider (openclaw #93470), which broke every
# instance provisioned on a pre-2026.6.9 image. config validate above is
# schema-only and cannot catch this; doctor resolves the paths and fails on a
# missing one, exactly as it does at boot.
#
# The plugin-load set config-writer.ts emits into plugins.load.paths. Kept
# explicit (readable + lets us model the conditional provider path below), but
# guarded against drift right after, so a newly added path can't silently slip
# the doctor assertion.
customizer_path="/usr/local/lib/node_modules/@kiloclaw/kiloclaw-customizer"
morning_briefing_path="/usr/local/lib/node_modules/@kiloclaw/kiloclaw-morning-briefing"
kilo_chat_path="/usr/local/lib/node_modules/@kiloclaw/kilo-chat"
kilocode_provider_path="/usr/local/lib/node_modules/@openclaw/kilocode-provider"
known_plugin_paths="$customizer_path $morning_briefing_path $kilo_chat_path $kilocode_provider_path"

# Drift guard: derive the controller's emitted set mechanically (like
# extract_pinned_version reads the Dockerfile) and fail if any non-LEGACY
# *_PLUGIN_PATH in config-writer.ts is not covered above. Without this, adding a
# fifth plugin path to config-writer.ts and forgetting it here would leave the
# doctor check silently under-testing the exact bricking class it guards.
# LEGACY_* constants are pruned (removed), never loaded, so they are excluded.
uncovered=$(python3 - "$REPO_ROOT/services/kiloclaw/controller/src/config-writer.ts" "$known_plugin_paths" <<'PY'
import re
import sys

src = open(sys.argv[1]).read()
known = set(sys.argv[2].split())
missing = []
for m in re.finditer(r"const\s+(\w*_PLUGIN_PATH)\s*=\s*'([^']+)'", src):
    name, path = m.group(1), m.group(2)
    if name.startswith("LEGACY_"):
        continue
    if not path.startswith("/usr/local/lib/node_modules/"):
        continue
    if path not in known:
        missing.append(path)
print(",".join(sorted(set(missing))))
PY
)
check "plugin-load set mirrors config-writer.ts (no drift)" "" "$uncovered"

# Assert the plugin-load set resolves in THIS image. The externalized provider
# path is emitted by the controller only when the plugin is installed
# (>= 2026.6.9); mirror that off whether the built candidate image actually has
# the plugin ($kcp_version, read from that image), so the assertion matches
# whichever openclaw version is currently pinned in the Dockerfile. This script
# validates the one pinned version it built; to cover an older selectable
# version, rebuild with that pin (IMAGE=... BUILD=true) and re-run.
positive_paths="\"$customizer_path\",\"$morning_briefing_path\",\"$kilo_chat_path\""
if [ -n "$kcp_version" ]; then
  positive_paths="$positive_paths,\"$kilocode_provider_path\""
fi
check "controller plugin-load set resolves in image (doctor)" \
  "ok" \
  "$(doctor_plugin_result "{\"plugins\":{\"load\":{\"paths\":[$positive_paths]}}}")"
# Self-check: a missing plugin path MUST be rejected, or the check above is inert.
check "doctor rejects a missing plugin path (self-check)" \
  "plugin-path-error" \
  "$(doctor_plugin_result '{"plugins":{"load":{"paths":["/usr/local/lib/node_modules/@openclaw/this-plugin-does-not-exist"]}}}')"

# ── Image CVE scan (grype) ───────────────────────────────────────────────────
scan_image_cves

echo
echo "=== Keyless verification: $PASS passed, $FAIL failed ==="

cat <<EOF

----------------------------------------------------------------------
This run covered only the checks that need NO Kilo API key. Before merge,
run the credentialed live smoke locally too (it loads a real key into the
freshly released OpenClaw, which is why nothing here runs in CI):

  export KILOCODE_API_KEY=<dedicated free-model key>   # not your personal key
  bash services/kiloclaw/scripts/tests/openclaw-upgrade-smoke.sh

That covers what CI cannot without a credential:
  - persisted-root upgrade boot (baseline -> candidate on the same /root)
  - gateway readiness + proxied Control UI
  - kilo-chat plugin load, diagnostics, and webhook route
  - app config-write routes (/_kilo/config/patch, agent-defaults, agents CRUD)
  - exec-approvals seeding
  - a real Auto Free agent turn through the live Kilo Gateway
----------------------------------------------------------------------
EOF

if [ "$FAIL" -gt 0 ] || [ "$CVE_GATE_FAILED" -gt 0 ]; then
  exit 1
fi
exit 0
