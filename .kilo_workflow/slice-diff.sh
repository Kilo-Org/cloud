#!/usr/bin/env bash
# Produce a slice's diff for review and a fingerprint that proves nobody moved
# it, per .kilo_workflow/WORKFLOW.md orchestrator step 3. Parallel slices share
# the worktree, so a reviewer must see exactly its slice's paths — and after a
# reviewer round those paths must be untouched, and after an implementer round
# no commit may have landed on them. Hand-assembling that kept going wrong;
# this does all of it.
#
#   slice-diff.sh <worktree> <out-file> -- <owned-path>...
#       Writes the slice diff (uncommitted changes on the owned paths, new
#       files included, full binary content) to <out-file> for a --file
#       dispatch, and prints one line: SNAPSHOT=<base>:<hash>
#
#   slice-diff.sh --check reviewer|implementer <snapshot-line> <worktree> <out-file> -- <owned-path>...
#       Recomputes and judges the round itself. Prints `OK` (exit 0) or
#       `VIOLATION: ...` (exit 1). reviewer: nothing may have changed — same
#       commits on the owned paths, same working-tree bytes. implementer: no
#       commit may have landed on the owned paths; edits are expected.
#
# The commit part of the fingerprint is scoped to the owned paths (the last
# commit touching them), so the orchestrator committing an unrelated finished
# slice mid-round does not void this one.
set -euo pipefail

MODE=emit EXPECT=""
if [ "${1:-}" = "--check" ]; then
  MODE=${2:?--check reviewer|implementer}
  EXPECT=${3:?expected SNAPSHOT=... line}
  case $MODE in reviewer | implementer) ;; *) echo "slice-diff: --check takes reviewer|implementer" >&2; exit 1 ;; esac
  case $EXPECT in SNAPSHOT=*) ;; *) echo "slice-diff: expected snapshot must be the printed SNAPSHOT=... line" >&2; exit 1 ;; esac
  shift 3
fi

WT=${1:?worktree} OUT=${2:?output diff file}
[ "${3:-}" = "--" ] || { echo "usage: slice-diff.sh [--check reviewer|implementer <snapshot>] <worktree> <out-file> -- <owned-path>..." >&2; exit 1; }
shift 3
[ $# -gt 0 ] || { echo "slice-diff: no owned paths given" >&2; exit 1; }

# add -N makes brand-new files visible to `git diff HEAD` without staging
# their content; --binary captures full content for binary files, so byte
# changes can never hide behind an identical "Binary files differ" line.
git -C "$WT" add -N -- "$@"
git -C "$WT" diff HEAD --binary -- "$@" > "$OUT"

BASE=$(git -C "$WT" log -1 --format=%H -- "$@" 2>/dev/null || echo none)
[ -n "$BASE" ] || BASE=none
if command -v sha256sum >/dev/null; then
  DIFF_HASH=$(sha256sum "$OUT" | cut -d' ' -f1)
else
  DIFF_HASH=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
fi
NOWLINE="SNAPSHOT=$BASE:$DIFF_HASH"

if [ "$MODE" = "emit" ]; then
  echo "$NOWLINE"
  exit 0
fi

EXP_BASE=${EXPECT#SNAPSHOT=}; EXP_BASE=${EXP_BASE%%:*}
NOW_BASE=${NOWLINE#SNAPSHOT=}; NOW_BASE=${NOW_BASE%%:*}
if [ "$NOW_BASE" != "$EXP_BASE" ]; then
  echo "VIOLATION: a commit landed on the owned paths during the round ($EXP_BASE -> $NOW_BASE) — the round is void"
  exit 1
fi
if [ "$MODE" = "reviewer" ] && [ "$NOWLINE" != "$EXPECT" ]; then
  echo "VIOLATION: the reviewer modified the owned paths (working-tree bytes changed) — the round is void"
  exit 1
fi
if [ "$MODE" = "implementer" ] && [ "$NOWLINE" = "$EXPECT" ]; then
  echo "VIOLATION: the implementer reported completion without changing the owned paths — the round is void"
  exit 1
fi
echo "OK"
