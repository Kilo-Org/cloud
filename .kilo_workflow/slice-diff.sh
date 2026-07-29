#!/usr/bin/env bash
# Produce a slice's diff for review and a fingerprint that proves nobody moved
# it, per .kilo_workflow/WORKFLOW.md orchestrator step 3. Parallel slices share
# the worktree, so a reviewer must see exactly its slice's paths — and after a
# reviewer round those paths must be untouched, and after an implementer round
# no new commits may exist. Hand-assembling that (`git add -N` first, snapshot
# after, compare later) kept going wrong; this does all of it.
#
#   slice-diff.sh <worktree> <out-file> -- <owned-path>...
#
# Writes the slice diff (uncommitted changes on the owned paths, new files
# included) to <out-file> for a --file dispatch, and prints one line:
#
#   SNAPSHOT=<head-sha>:<diff-hash>
#
# Run it again after a round and compare the whole line:
#   - reviewer round: the line must be IDENTICAL (same commits, same bytes on
#     the owned paths) — any difference voids the round.
#   - implementer round: <head-sha> must be unchanged (the implementer never
#     commits); the diff hash is expected to change.
set -euo pipefail

WT=${1:?worktree} OUT=${2:?output diff file}
[ "${3:-}" = "--" ] || { echo "usage: slice-diff.sh <worktree> <out-file> -- <owned-path>..." >&2; exit 1; }
shift 3
[ $# -gt 0 ] || { echo "slice-diff: no owned paths given" >&2; exit 1; }

# add -N makes brand-new files visible to `git diff HEAD` without staging
# their content.
git -C "$WT" add -N -- "$@"
git -C "$WT" diff HEAD -- "$@" > "$OUT"

HEAD_SHA=$(git -C "$WT" rev-parse HEAD)
if command -v sha256sum >/dev/null; then
  DIFF_HASH=$(sha256sum "$OUT" | cut -d' ' -f1)
else
  DIFF_HASH=$(shasum -a 256 "$OUT" | cut -d' ' -f1)
fi
echo "SNAPSHOT=$HEAD_SHA:$DIFF_HASH"
