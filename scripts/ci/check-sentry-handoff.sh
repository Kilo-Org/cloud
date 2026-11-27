#!/usr/bin/env bash
#
# Checks for the Cloud Agent Sentry upload job (.github/workflows/cloud-agent-sentry-sourcemaps.yml).
#
#   check-sentry-handoff.sh <archive.tgz>   The hand-off archive comes from the deploy job, which runs
#     package code, so it may hold only what stageSentryUploads writes: uploads.json, sentry-cli,
#     and code files with their maps in numbered folders. Anything else is refused, in particular a
#     dotfile, .sentryclirc, .env, sentry.properties, an absolute path, `..`, a link or a device.
#   check-sentry-handoff.sh --artifact <dir>   The downloaded artifact directory must hold exactly
#     one regular file, cloud-agent-sentry.tgz.
#   check-sentry-handoff.sh --workdir <dir>   sentry-cli reads .sentryclirc from its working
#     directory and every ancestor, and sentry.properties from there too: none may exist up to /.
set -euo pipefail
export LC_ALL=C

fail() {
  printf '::error title=sentry-handoff::%s\n' "$1" >&2
  exit 1
}

case ${1-} in
  --artifact)
    dir=${2-}
    [[ -n $dir && -d $dir && ! -L $dir ]] || fail "no artifact directory given"
    entries=$(find "$dir" -mindepth 1 -printf '%y %P\n')
    [[ $entries == "f cloud-agent-sentry.tgz" ]] || fail "the artifact must hold exactly one regular file, cloud-agent-sentry.tgz"
    exit 0
    ;;
  --workdir)
    dir=${2-}
    [[ -n $dir && -d $dir ]] || fail "no working directory given"
    dir=$(cd "$dir" && pwd -P)
    while :; do
      for name in .sentryclirc sentry.properties; do
        [[ ! -e $dir/$name && ! -L $dir/$name ]] || fail "$dir/$name exists; sentry-cli would read it"
      done
      [[ $dir == / ]] && break
      dir=$(dirname "$dir")
    done
    exit 0
    ;;
esac

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
