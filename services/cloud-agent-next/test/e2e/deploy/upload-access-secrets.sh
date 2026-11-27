#!/usr/bin/env bash
# Usage: upload-access-secrets.sh <script name> <values file | ->
#
# README "Closed CI path", step 12: the one-time operator upload of the Access
# service token to the e2e Worker, run from a disposable VM over the approved
# Wrangler login route, after the closed deploy's readback. It is never run by
# CI. The preflight refuses any script other than cloud-agent-e2e-test and any
# secret name other than E2E_ACCESS_CLIENT_ID and E2E_ACCESS_CLIENT_SECRET, and
# requires both. The values come only from standard input (`-`) or from a file
# with mode 0600, as `NAME=value` lines; each value reaches
# `wrangler secret put` on standard input and is never printed.
#
# WRANGLER_BIN overrides the wrangler command (tests only); by default the
# package's own wrangler runs through `pnpm exec`.
set -euo pipefail
set +x

ALLOWED_SCRIPT="cloud-agent-e2e-test"
ALLOWED_NAMES=(E2E_ACCESS_CLIENT_ID E2E_ACCESS_CLIENT_SECRET)
SERVICE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)

fail() {
  printf 'upload-access-secrets: %s\n' "$1" >&2
  exit 1
}

[[ $# -eq 2 ]] || fail 'usage: upload-access-secrets.sh <script name> <values file | ->'
script="$1"
source="$2"
[[ "$script" == "$ALLOWED_SCRIPT" ]] || fail "refusing script '$script': only $ALLOWED_SCRIPT"

if [[ "$source" == - ]]; then
  input=$(cat)
else
  [[ -f "$source" ]] || fail "no such values file: $source"
  mode=$(stat -c '%a' "$source" 2>/dev/null || stat -f '%Lp' "$source")
  [[ "$mode" == 600 ]] || fail "refusing $source: mode $mode, expected 600"
  input=$(cat "$source")
fi

declare -A values=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" ]] && continue
  name="${line%%=*}"
  [[ "$line" == *=* ]] || fail 'every line must be NAME=value'
  allowed=false
  for candidate in "${ALLOWED_NAMES[@]}"; do
    [[ "$name" == "$candidate" ]] && allowed=true
  done
  $allowed || fail "refusing secret name '$name': only ${ALLOWED_NAMES[*]}"
  [[ -z "${values[$name]+set}" ]] || fail "$name is given twice"
  values[$name]="${line#*=}"
done <<<"$input"
for name in "${ALLOWED_NAMES[@]}"; do
  [[ -n "${values[$name]:-}" ]] || fail "$name is missing or empty"
done

if [[ -n "${WRANGLER_BIN:-}" ]]; then
  wrangler=("$WRANGLER_BIN")
else
  wrangler=(pnpm exec wrangler)
fi
cd "$SERVICE_DIR"
for name in "${ALLOWED_NAMES[@]}"; do
  printf '+ printf %%s "[redacted]" | wrangler secret put %s --name %s\n' "$name" "$script"
  printf '%s' "${values[$name]}" | "${wrangler[@]}" secret put "$name" --name "$script" >/dev/null
done
printf 'Uploaded %s to %s.\n' "${ALLOWED_NAMES[*]}" "$script"
