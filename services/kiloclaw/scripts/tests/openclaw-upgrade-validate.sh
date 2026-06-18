#!/usr/bin/env bash
set -uo pipefail

# START HERE — single entry point for validating a KiloClaw OpenClaw bump locally.
#
# Run this and follow the guidance; you do not need to know the individual
# scripts. It runs, in order:
#
#   Phase 1  keyless verification   — builds the candidate image, checks the
#            version / bundle patches / plugins, validates config schema, and
#            runs a full grype CVE scan. No Kilo API key needed.
#
#   Phase 2  credentialed live smoke — builds the before/after images, performs
#            the persisted-root upgrade (boots baseline, then candidate on the
#            same /root), and runs every assertion incl. a real Auto Free gateway
#            turn. Needs a dedicated free-model Kilo API key.
#
# OpenClaw is never built or run in CI (it is a security-sensitive upstream), so
# this is the gate a human runs locally before marking the bump PR ready.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KILOCLAW_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Shared credential lookup so preflight decides "is a key available?" exactly the
# way smoke-live-provider.sh does (active provider's token, not any occurrence).
source "$SCRIPT_DIR/provider-creds.sh"

hr() { printf -- '----------------------------------------------------------------------\n'; }
section() { echo; hr; echo "$1"; hr; }

# When Phase 2 cannot run, ask whether to do the keyless checks anyway or stop.
# Stops by default so a missing key/branch is not silently treated as "done".
ask_continue_keyless_or_stop() {
  if [ -t 0 ]; then
    printf '\nContinue with the keyless checks only? [y/N] '
    read -r reply
    case "${reply:-}" in
      [yY]*) echo "Continuing with the keyless checks only ..." ;;
      *) echo "Stopped."; exit 2 ;;
    esac
  else
    echo
    echo "(non-interactive shell: continuing with the keyless checks only.)"
  fi
}

VERIFY_RESULT="not run"
SMOKE_RESULT="not run"

# Capture each phase's output (it still streams via tee) so the final summary can
# echo the pass/fail counts and the grype CVE totals without scrolling back.
PHASE1_LOG="$(mktemp)"
PHASE2_LOG="$(mktemp)"
cleanup() { rm -f "$PHASE1_LOG" "$PHASE2_LOG"; }
trap cleanup EXIT

section "OpenClaw upgrade — local validation"
echo "Validates an OpenClaw version bump end to end. Follow the notes below."

# ── Preflight ────────────────────────────────────────────────────────────────
section "Preflight"

if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker is not running. Start Docker and re-run this script."
  exit 1
fi
echo "✓ Docker is running"

# Is this an actual bump branch? Compare the baseline (BASE_REF, default
# origin/main — the same "before" Phase 2 uses) to the candidate.
BASE_REF="${BASE_REF:-origin/main}"
[ "$BASE_REF" = "origin/main" ] && git fetch origin main -q 2>/dev/null || true
VER_BEFORE=$(git show "$BASE_REF:services/kiloclaw/Dockerfile" 2>/dev/null \
  | grep -oE 'openclaw@[0-9]+\.[0-9]+\.[0-9]+' | head -1 | cut -d'@' -f2)
VER_AFTER=$(grep -oE 'openclaw@[0-9]+\.[0-9]+\.[0-9]+' "$KILOCLAW_DIR/Dockerfile" \
  | head -1 | cut -d'@' -f2)
IS_BUMP=1
if [ -z "$VER_AFTER" ]; then
  echo "✗ Could not read the OpenClaw pin from the Dockerfile."
  exit 1
fi
if [ -n "$VER_BEFORE" ] && [ "$VER_BEFORE" = "$VER_AFTER" ]; then
  IS_BUMP=0
  echo "• Not a bump branch — $BASE_REF and the working tree both pin openclaw@$VER_AFTER"
else
  echo "✓ Bump branch: openclaw ${VER_BEFORE:-?} -> $VER_AFTER  (baseline: $BASE_REF)"
fi

# Phase 1 (image-checks) builds the WORKING TREE; Phase 2 (smoke) builds committed
# HEAD via worktrees. ANY working-tree deviation from HEAD — tracked changes OR
# untracked files (which can enter the Phase 1 image via the Dockerfile's COPY
# inputs) — means the two phases could validate different candidates, so no single
# candidate passes both. Refuse by default. ALLOW_DIRTY_TREE=true is an explicit
# experimentation override; such a run is flagged DIRTY_TREE and can never report
# a clean validation (see the summary).
DIRTY_TREE=0
if [ -n "$(git status --porcelain --untracked-files=all 2>/dev/null)" ]; then
  if [ "${ALLOW_DIRTY_TREE:-false}" != "true" ]; then
    echo "✗ Working tree is not clean (uncommitted or untracked files). Phase 1 builds"
    echo "  your working tree but Phase 2 builds committed HEAD — the two phases would"
    echo "  validate different candidates. Commit or stash (git stash -u) so the tree"
    echo "  matches HEAD, then re-run to validate exactly what merges."
    echo "  (Experimentation only: set ALLOW_DIRTY_TREE=true — that run cannot report a"
    echo "  clean validation.)"
    exit 2
  fi
  DIRTY_TREE=1
  echo "⚠ ALLOW_DIRTY_TREE=true and the working tree is not clean: Phase 1 builds your"
  echo "  working tree, Phase 2 builds committed HEAD — this run will NOT report a"
  echo "  clean validation regardless of results."
fi

# Optional CVE scanner.
if command -v grype >/dev/null 2>&1; then
  echo "✓ grype installed (CVE scan will run in Phase 1)"
else
  echo "• grype not installed — CVE scan will be skipped (install: brew install grype)"
fi

# Credential for Phase 2: env var, or the ACTIVE provider's token in the Kilo CLI
# config (matching smoke-live-provider.sh — a stale/inactive-provider token does
# not count, so preflight never schedules Phase 2 for creds the smoke would reject).
HAVE_KEY=0
if [ -n "${KILOCODE_API_KEY:-}" ]; then
  HAVE_KEY=1
  echo "✓ KILOCODE_API_KEY is set"
elif [ -n "$(read_active_provider_value kilocodeToken 2>/dev/null)" ]; then
  HAVE_KEY=1
  echo "✓ Active Kilo CLI credential found"
else
  echo "• No Kilo API key set"
fi

# ── Will Phase 2 run? Decide and explain it now, before the long build. ───────
# PHASE2_MODE: "upgrade"  = real before->after upgrade test (a bump branch),
#              "mechanics" = same version both sides (exercises the harness only),
#              ""          = skipped.
PHASE2_MODE=""
SMOKE_SAME_VERSION="false"

echo
echo "Plan for this run:"
echo "  • Phase 1 — keyless checks (build, patches, config, CVE scan): will run"

if [ "$IS_BUMP" -eq 1 ] && [ "$HAVE_KEY" -eq 1 ]; then
  PHASE2_MODE="upgrade"
  echo "  • Phase 2 — credentialed live smoke: will run"

elif [ "$IS_BUMP" -eq 1 ]; then
  echo "  • Phase 2 — credentialed live smoke: WILL BE SKIPPED (no Kilo API key is set)"
  echo
  echo "Phase 2 (the live smoke) is half the coverage and needs a Kilo API key."
  echo "For the full validation, set a dedicated free-model key and re-run:"
  echo "    export KILOCODE_API_KEY=<key>   # from https://app.kilo.ai/profile (bottom)"
  echo "    bash $0"
  ask_continue_keyless_or_stop

elif [ "$HAVE_KEY" -eq 1 ]; then
  # Not a bump branch, but a key is available — offer the mechanics-only run.
  echo "  • Phase 2 — credentialed live smoke: optional (not a bump branch)"
  echo
  echo "You are not on a bump branch, so there is no real upgrade to compare. You can"
  echo "still run the smoke to exercise the mechanics — it boots the same OpenClaw"
  echo "version on both sides, checking the harness rather than an actual upgrade."
  if [ -t 0 ]; then
    printf '\nRun the smoke anyway to exercise the mechanics? [y/N] '
    read -r reply_mech
    case "${reply_mech:-}" in
      [yY]*)
        PHASE2_MODE="mechanics"
        SMOKE_SAME_VERSION="true"
        echo "Will run Phase 2 in mechanics mode (same version both sides)." ;;
      *)
        echo "Skipping Phase 2; running the keyless checks only." ;;
    esac
  else
    echo "(non-interactive shell: skipping Phase 2; running the keyless checks only.)"
  fi

else
  echo "  • Phase 2 — credentialed live smoke: WILL BE SKIPPED (not a bump branch, no API key)"
  echo
  echo "You are not on a bump branch (the kind the bump bot opens automatically), so"
  echo "there is no upgrade to validate. Phase 2 runs on a feat/bump-openclaw-* branch."
  ask_continue_keyless_or_stop
fi

# ── Phase 1: keyless verification ────────────────────────────────────────────
section "Phase 1/2 — keyless verification (build, patches, config, CVE scan)"
bash "$SCRIPT_DIR/openclaw-upgrade-image-checks.sh" 2>&1 | tee "$PHASE1_LOG"
if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  VERIFY_RESULT="passed"
  echo
  echo "✓ Phase 1 passed"
else
  VERIFY_RESULT="FAILED"
  echo
  echo "✗ Phase 1 FAILED — review the output above before going further."
fi

# ── Phase 2: credentialed live smoke ─────────────────────────────────────────
section "Phase 2/2 — credentialed live smoke (persisted-root upgrade + gateway turn)"
if [ "$VERIFY_RESULT" = "FAILED" ]; then
  # The overall result is already a failure; don't spend two more image builds and
  # live gateway calls. Fix Phase 1 and re-run.
  SMOKE_RESULT="skipped (Phase 1 failed)"
  echo "Skipped — Phase 1 failed, so this run already fails. Fix the image issues"
  echo "above and re-run before spending the live smoke's builds and gateway calls."
elif [ -z "$PHASE2_MODE" ]; then
  if [ "$IS_BUMP" -eq 0 ]; then
    SMOKE_RESULT="skipped (not a bump branch)"
  else
    SMOKE_RESULT="skipped (no API key)"
  fi
  echo "Skipped — see the preflight note above."
else
  if [ "$PHASE2_MODE" = "mechanics" ]; then
    echo "Mechanics mode: same OpenClaw version on both sides — this checks the harness,"
    echo "not a real upgrade. (You are not on a bump branch.)"
    echo
  fi
  # Build from committed HEAD via worktrees, so a dirty working tree (e.g.
  # untracked notes) is safe and does not enter the image. ALLOW_SAME lets the
  # smoke run when before/after pin the same version (mechanics mode).
  ALLOW_DIRTY_CHECKOUT="${ALLOW_DIRTY_CHECKOUT:-true}" \
    ALLOW_SAME_OPENCLAW_VERSION="$SMOKE_SAME_VERSION" \
    bash "$SCRIPT_DIR/openclaw-upgrade-smoke.sh" 2>&1 | tee "$PHASE2_LOG"
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then
    if [ "$PHASE2_MODE" = "mechanics" ]; then
      SMOKE_RESULT="passed (mechanics only)"
    else
      SMOKE_RESULT="passed"
    fi
    echo
    echo "✓ Phase 2 passed"
  else
    SMOKE_RESULT="FAILED"
    echo
    echo "✗ Phase 2 FAILED — review the output above."
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
# Pull the streamed-by details back out of the captured phase logs so the summary
# stands on its own: pass/fail counts per phase + the grype CVE totals.
P1_COUNTS=$(grep -oE '[0-9]+ passed, [0-9]+ failed' "$PHASE1_LOG" 2>/dev/null | tail -1)
P2_COUNTS=$(grep -oE '[0-9]+ passed, [0-9]+ failed' "$PHASE2_LOG" 2>/dev/null | tail -1)
CVE_SUMMARY=$(grep -E '^[[:space:]]*severity:' "$PHASE1_LOG" 2>/dev/null | tail -1 | sed 's/^[[:space:]]*severity:[[:space:]]*//')

section "Summary"
echo "  Phase 1 (keyless verification): $VERIFY_RESULT${P1_COUNTS:+  (${P1_COUNTS})}"
[ -n "$CVE_SUMMARY" ] && echo "    grype CVE scan: $CVE_SUMMARY"
echo "  Phase 2 (credentialed smoke):   $SMOKE_RESULT${P2_COUNTS:+  (${P2_COUNTS})}"
echo

if [ "$VERIFY_RESULT" = "FAILED" ] || [ "$SMOKE_RESULT" = "FAILED" ]; then
  echo "✗ A phase failed — do not mark the PR ready. Fix the issues and re-run."
  exit 1
fi
if [ "$DIRTY_TREE" -eq 1 ]; then
  echo "⚠ Not a clean validation — the tracked tree was dirty (ALLOW_DIRTY_TREE), so"
  echo "  Phase 1 built your working tree and Phase 2 built committed HEAD. Commit and"
  echo "  re-run to validate a single candidate before marking the PR ready."
  exit 2
fi
if [ "$VERIFY_RESULT" = "passed" ] && [ "$SMOKE_RESULT" = "passed" ]; then
  echo "✓ Both phases passed. Record the evidence on the PR (versions, results, and"
  echo "  any notable grype findings), then a human can mark it ready. Never paste"
  echo "  API keys, tokens, or prompts into the PR."
  exit 0
fi
if [ "$SMOKE_RESULT" = "passed (mechanics only)" ]; then
  echo "✓ Keyless checks and the smoke mechanics passed — but this is NOT a bump branch,"
  echo "  so no real upgrade was validated. Run on a feat/bump-openclaw-* branch for the"
  echo "  actual upgrade validation."
  exit 0
fi
echo "• Validation incomplete — Phase 2 did not run. Follow the guidance above,"
echo "  then re-run this script before marking the PR ready."
exit 2
