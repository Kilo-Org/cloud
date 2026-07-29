#!/usr/bin/env bash
# Git-state baseline for the E2E verifier's byte-identical restore contract,
# per .kilo/agent/e2e-verifier.md. Snapshotting and comparing NUL-delimited
# status, binary diffs, and untracked hashes by hand is exactly the kind of
# destructive ritual a cheap model gets wrong; this does the mechanical part.
# Restoring is still the agent's job — this tells it exactly what diverged.
#
#   baseline.sh snapshot <worktree> <baseline-dir>   # record the pre-run state
#   baseline.sh check <worktree> <baseline-dir>      # compare; OK or the diverging files
#
# <baseline-dir> must live OUTSIDE every repository (scratch). check prints
# `OK` (exit 0) when the state matches byte-for-byte, otherwise one line per
# divergence (exit 1) — any mismatch is a verification failure, never
# something to claim past.
set -euo pipefail

CMD=${1:?usage: baseline.sh snapshot|check <worktree> <baseline-dir>}
WT=${2:?worktree} DIR=${3:?baseline dir}
[ -d "$WT" ] || { echo "baseline: no such worktree: $WT" >&2; exit 1; }
case "$DIR" in "$WT"/*) echo "baseline: the baseline dir must live outside the repository" >&2; exit 1 ;; esac

capture() {
  local out=$1
  mkdir -p "$out"
  git -C "$WT" rev-parse HEAD > "$out/head"
  git -C "$WT" status --porcelain=v2 -z --untracked-files=all > "$out/status.z"
  git -C "$WT" diff --binary > "$out/worktree.diff"
  git -C "$WT" diff --binary --cached > "$out/index.diff"
  # Untracked files: byte hash, mode, and symlink target each — a same-size
  # content swap or a mode flip must not slip through.
  git -C "$WT" ls-files --others --exclude-standard -z | while IFS= read -r -d '' p; do
    if [ -L "$WT/$p" ]; then
      printf 'link\t%s\t%s\n' "$(readlink "$WT/$p")" "$p"
    elif command -v sha256sum >/dev/null; then
      printf 'file\t%s\t%s\t%s\n' "$(stat -f %p "$WT/$p" 2>/dev/null || stat -c %a "$WT/$p")" \
        "$(sha256sum "$WT/$p" | cut -d' ' -f1)" "$p"
    else
      printf 'file\t%s\t%s\t%s\n' "$(stat -f %p "$WT/$p" 2>/dev/null || stat -c %a "$WT/$p")" \
        "$(shasum -a 256 "$WT/$p" | cut -d' ' -f1)" "$p"
    fi
  done | sort > "$out/untracked.tsv"
}

case $CMD in
  snapshot)
    capture "$DIR"
    echo "baseline recorded in $DIR"
    ;;
  check)
    [ -f "$DIR/head" ] || { echo "baseline: no snapshot in $DIR" >&2; exit 1; }
    NOW=$(mktemp -d "${TMPDIR:-/tmp}/kilo-baseline-check.XXXXXX")
    # Kept on mismatch so the printed diff commands stay runnable.
    trap '[ "${fail:-1}" -eq 0 ] && rm -rf "$NOW"' EXIT
    capture "$NOW"
    fail=0
    for f in head status.z worktree.diff index.diff untracked.tsv; do
      cmp -s "$DIR/$f" "$NOW/$f" && continue
      fail=1
      case $f in
        head) echo "DIVERGED head: $(cat "$DIR/$f") -> $(cat "$NOW/$f")" ;;
        untracked.tsv)
          echo "DIVERGED untracked files (hash/mode/link or presence):"
          diff "$DIR/$f" "$NOW/$f" | grep '^[<>]' | sed 's/^</  baseline only:/; s/^>/  now:/'
          ;;
        *) echo "DIVERGED $f (run: diff $DIR/$f $NOW/$f)" ;;
      esac
    done
    [ "$fail" -eq 0 ] && echo "OK"
    exit "$fail"
    ;;
  *) echo "usage: baseline.sh snapshot|check <worktree> <baseline-dir>" >&2; exit 1 ;;
esac
