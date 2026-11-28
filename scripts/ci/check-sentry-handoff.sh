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
#   check-sentry-handoff.sh --upload-args <stage> <index>   Prints upload <index> of
#     <stage>/uploads.json as NUL-separated sentry-cli arguments, map paths made absolute under
#     <stage>. Only what stageSentryUploads (services/cloud-agent-next/scripts/sentry-source-maps.ts)
#     writes passes: `sourcemaps upload`, exactly `--org kilo-code` and `--project kilo-cloud-agent`,
#     at most one `--release cloud-agent-wrapper@<64 hex>` and one `--wait-for <seconds>`, the bare
#     flags `--strict`, `--validate` and `--no-rewrite`, and map paths `<n>/<file>`.
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
  --upload-args)
    stage=${2-}
    index=${3-}
    [[ -n $stage && $stage == /* && -d $stage && $index =~ ^[0-9]+$ ]] ||
      fail "--upload-args needs an absolute stage directory and an upload index"
    list=$(mktemp)
    jq -j --argjson i "$index" '
      .[$i] | if type == "array" and length > 0 and all(type == "string")
        then .[] + "\u0000" else error("not a list of strings") end
    ' "$stage/uploads.json" >"$list" 2>/dev/null || fail "upload $index is not a list of arguments"
    raw=()
    while IFS= read -r -d '' arg; do raw+=("$arg"); done <"$list"
    rm -f "$list"
    [[ ${raw[0]-} == sourcemaps && ${raw[1]-} == upload ]] || fail "upload $index is not a source map upload"
    args=(sourcemaps upload)
    org='' project='' release='' wait_for='' maps=0
    for ((k = 2; k < ${#raw[@]}; k++)); do
      arg=${raw[k]}
      case $arg in
        --org | --project | --release | --wait-for)
          ((k + 1 < ${#raw[@]})) || fail "upload $index: $arg has no value"
          value=${raw[k + 1]}
          k=$((k + 1))
          case $arg in
            --org)
              [[ -z $org && $value == kilo-code ]] || fail "upload $index: --org must be kilo-code, once"
              org=1
              ;;
            --project)
              [[ -z $project && $value == kilo-cloud-agent ]] ||
                fail "upload $index: --project must be kilo-cloud-agent, once"
              project=1
              ;;
            --release)
              [[ -z $release && $value =~ ^cloud-agent-wrapper@[0-9a-f]{64}$ ]] ||
                fail "upload $index: --release must be cloud-agent-wrapper@<64 hex>, once"
              release=1
              ;;
            --wait-for)
              [[ -z $wait_for && $value =~ ^[0-9]{1,4}$ ]] || fail "upload $index: --wait-for must be seconds, once"
              wait_for=1
              ;;
          esac
          args+=("$arg" "$value")
          ;;
        --strict | --validate | --no-rewrite) args+=("$arg") ;;
        *)
          # Any other argument must be a map path relative to the hand-off.
          [[ $arg =~ ^[0-9]+/[A-Za-z0-9_][A-Za-z0-9_.-]*$ && $arg != *..* ]] ||
            fail "upload $index names an argument that is neither an allowed flag nor a map path"
          args+=("$stage/$arg")
          maps=$((maps + 1))
          ;;
      esac
    done
    [[ -n $org && -n $project ]] || fail "upload $index must name --org kilo-code and --project kilo-cloud-agent"
    ((maps > 0)) || fail "upload $index names no map path"
    printf '%s\0' "${args[@]}"
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
  [[ $member =~ ^(uploads\.json|handoff\.json|sentry-cli|[0-9]+/?|[0-9]+/[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*\.(js|mjs|cjs)(\.map)?)$ ]] ||
    fail "the hand-off archive holds an unexpected member"
done <<<"$names"
