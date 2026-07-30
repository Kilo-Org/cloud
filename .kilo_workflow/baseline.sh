#!/usr/bin/env bash
# Git-state baseline for the E2E verifier's byte-identical restore contract,
# per .kilo/agent/e2e-verifier.md. Snapshotting and comparing NUL-delimited
# status, binary diffs, and untracked hashes by hand is exactly the kind of
# destructive ritual a cheap model gets wrong; this does the mechanical part.
# Restoring is still the agent's job — this tells it exactly what diverged.
#
#   baseline.sh snapshot <worktree> <baseline-dir> [--include <ignored-path>]...
#   baseline.sh check <worktree> <baseline-dir> [--include <ignored-path>]...
#
# <baseline-dir> must live OUTSIDE every repository (scratch). A successful
# check prints `OK`, consumes the snapshot, and exits 0. A mismatch prints one
# line per divergence, retains both sides as evidence, and exits 1.
set -euo pipefail

CMD=${1:?usage: baseline.sh snapshot|check <worktree> <baseline-dir> [--include <ignored-path>]...}
WT=${2:?worktree} DIR=${3:?baseline dir}
shift 3
INCLUDES=()
while [ $# -gt 0 ]; do
  [ "$1" = "--include" ] || { echo "baseline: unknown option $1" >&2; exit 1; }
  include=${2:?--include needs a repository-relative path}
  case "$include" in
    /* | .. | ../* | */../* | */..) echo "baseline: --include must stay inside the worktree: $include" >&2; exit 1 ;;
  esac
  INCLUDES+=("$include")
  shift 2
done
[ -d "$WT" ] || { echo "baseline: no such worktree: $WT" >&2; exit 1; }
# Canonicalize before comparing — a relative or symlinked path must not smuggle
# the baseline into the repository (or make the repository the baseline).
WT=$(cd "$WT" && pwd -P)
CREATED=0
[ -d "$DIR" ] || { mkdir -p "$DIR"; CREATED=1; }
DIR=$(cd "$DIR" && pwd -P)
case "$DIR" in
  "$WT" | "$WT"/*)
    [ "$CREATED" -eq 1 ] && rmdir "$DIR" 2>/dev/null
    echo "baseline: the baseline dir must live outside the repository ($WT)" >&2
    exit 1
    ;;
esac

capture() {
  local out=$1 p hash
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
    elif [ ! -f "$WT/$p" ]; then
      # FIFOs and sockets block readers; record existence only.
      printf 'other\t%s\n' "$p"
    elif command -v sha256sum >/dev/null; then
      printf 'file\t%s\t%s\t%s\n' "$(stat -c %a "$WT/$p" 2>/dev/null || stat -f %p "$WT/$p")" \
        "$(sha256sum "$WT/$p" | cut -d' ' -f1)" "$p"
    else
      printf 'file\t%s\t%s\t%s\n' "$(stat -c %a "$WT/$p" 2>/dev/null || stat -f %p "$WT/$p")" \
        "$(shasum -a 256 "$WT/$p" | cut -d' ' -f1)" "$p"
    fi
  done | sort > "$out/untracked.tsv"

  # Git omits ignored files from every state above. Hash only the explicit
  # ignored paths a verifier is allowed to edit; absence is state too.
  : > "$out/included.tsv"
  for p in "${INCLUDES[@]+"${INCLUDES[@]}"}"; do
    if [ -L "$WT/$p" ]; then
      printf 'link\t%s\t%s\n' "$(readlink "$WT/$p")" "$p"
    elif [ -f "$WT/$p" ]; then
      if command -v sha256sum >/dev/null; then
        hash=$(sha256sum "$WT/$p" | cut -d' ' -f1)
      else
        hash=$(shasum -a 256 "$WT/$p" | cut -d' ' -f1)
      fi
      printf 'file\t%s\t%s\t%s\n' \
        "$(stat -c %a "$WT/$p" 2>/dev/null || stat -f %p "$WT/$p")" "$hash" "$p"
    elif [ -e "$WT/$p" ]; then
      echo "baseline: --include supports files, symlinks, or absent paths, not $p" >&2
      return 1
    else
      printf 'missing\t-\t%s\n' "$p"
    fi
  done | sort > "$out/included.tsv"
}

case $CMD in
  snapshot)
    # Refuse to re-snapshot: a verifier that re-runs the checklist after its
    # temporary edits would otherwise bless the dirty state as the baseline.
    [ ! -f "$DIR/head" ] || { echo "baseline: $DIR already holds a snapshot — check against it; never re-baseline mid-run" >&2; exit 1; }
    # Capture to a sibling temp dir and publish atomically, so a killed
    # snapshot can never pass for a complete one.
    TMP=$(mktemp -d "$DIR.tmp.XXXXXX")
    { capture "$TMP" && [ -s "$TMP/head" ]; } || { rm -rf "$TMP"; echo 'baseline: capture failed' >&2; exit 1; }
    rmdir "$DIR" 2>/dev/null || { echo "baseline: $DIR exists and is not empty — refusing to overwrite" >&2; rm -rf "$TMP"; exit 1; }
    mv "$TMP" "$DIR"
    echo "baseline recorded in $DIR"
    ;;
  check)
    [ -f "$DIR/head" ] || { echo "baseline: no snapshot in $DIR" >&2; exit 1; }
    NOW=$(mktemp -d "${TMPDIR:-/tmp}/kilo-baseline-check.XXXXXX")
    # Kept on mismatch so the printed diff commands stay runnable.
    trap '[ "${fail:-1}" -eq 0 ] && rm -rf "$NOW"' EXIT
    { capture "$NOW" && [ -s "$NOW/head" ]; } || { rm -rf "$NOW"; echo 'baseline: capture failed' >&2; exit 1; }
    fail=0
    for f in head status.z worktree.diff index.diff untracked.tsv included.tsv; do
      cmp -s "$DIR/$f" "$NOW/$f" && continue
      fail=1
      case $f in
        head) echo "DIVERGED head: $(cat "$DIR/$f") -> $(cat "$NOW/$f")" ;;
        untracked.tsv | included.tsv)
          echo "DIVERGED ${f%.tsv} files (hash/mode/link or presence):"
          # diff exits 1 on difference — normal here, must not abort the report.
          { diff "$DIR/$f" "$NOW/$f" || true; } | { grep '^[<>]' || true; } | sed 's/^</  baseline only:/; s/^>/  now:/'
          ;;
        *) echo "DIVERGED $f (run: diff $DIR/$f $NOW/$f)" ;;
      esac
    done
    if [ "$fail" -eq 0 ]; then
      rm -rf "$DIR"
      echo "OK"
    fi
    exit "$fail"
    ;;
  *) echo "usage: baseline.sh snapshot|check <worktree> <baseline-dir> [--include <ignored-path>]..." >&2; exit 1 ;;
esac
