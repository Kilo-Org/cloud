#!/usr/bin/env bash
#
# Checks the Cloud Agent source map hand-off archive before the Sentry upload job unpacks it
# (.github/workflows/cloud-agent-sentry-sourcemaps.yml). The archive comes from the deploy job, which
# runs package code, so it may hold only what stageSentryUploads writes: uploads.json, sentry-cli,
# and code files with their maps in numbered folders. Anything else is refused, in particular a
# dotfile, .sentryclirc, .env, sentry.properties, an absolute path, `..`, a link or a device.
#
# Usage: check-sentry-handoff.sh <archive.tgz>
set -euo pipefail
export LC_ALL=C

fail() {
  printf '::error title=sentry-handoff::%s\n' "$1" >&2
  exit 1
}

archive=${1-}
[[ -n $archive && -f $archive ]] || fail "no hand-off archive given"

listing=$(tar -tvzf "$archive") || fail "the hand-off archive cannot be listed"
names=$(tar -tzf "$archive") || fail "the hand-off archive cannot be listed"

# Regular files and directories only: no symlink, hard link, device or fifo.
while IFS= read -r line; do
  [[ -z $line ]] && continue
  case ${line:0:1} in
    - | d) ;;
    *) fail "the hand-off archive holds a member of type ${line:0:1}" ;;
  esac
done <<<"$listing"

while IFS= read -r name; do
  [[ -z $name ]] && continue
  member=${name#./}
  [[ -z $member ]] && continue
  [[ $member != *..* ]] || fail "the hand-off archive holds a member with .."
  [[ $member =~ ^(uploads\.json|sentry-cli|[0-9]+/?|[0-9]+/[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(js|mjs|cjs)(\.map)?)$ ]] ||
    fail "the hand-off archive holds an unexpected member"
done <<<"$names"
