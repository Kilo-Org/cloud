#!/usr/bin/env bash
# Usage: check-access-closed.sh <hostname>
#
# Sends one anonymous GET to https://<hostname>/ and passes only when Cloudflare
# Access refuses it: a redirect to <team>.cloudflareaccess.com, or 401/403
# without the e2e Worker's own refusal marker. A Worker answer of any kind means
# the request reached the Worker without passing Access, so the check fails.
set -euo pipefail

host="${1:-}"
if [[ ! "$host" =~ ^[a-z0-9.-]+$ ]]; then
  printf 'Usage: check-access-closed.sh <hostname>\n' >&2
  exit 2
fi

headers=$(mktemp)
trap 'rm -f "$headers"' EXIT
result=$(curl -sS -o /dev/null -D "$headers" --max-time 30 -w '%{http_code} %{redirect_url}' "https://$host/")
status="${result%% *}"
location="${result#* }"

if grep -qi '^x-cloud-agent-e2e-refusal:' "$headers"; then
  printf 'Access did not intercept https://%s/: the Worker itself answered %s.\n' "$host" "$status" >&2
  exit 1
fi
case "$status" in
  301 | 302 | 303 | 307 | 308)
    if [[ "$location" =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com/ ]]; then
      printf 'Access refused the anonymous request: %s to %s\n' "$status" "${location%%\?*}"
      exit 0
    fi
    ;;
  401 | 403)
    printf 'Access refused the anonymous request: %s\n' "$status"
    exit 0
    ;;
esac
printf 'Access did not refuse https://%s/: status %s.\n' "$host" "$status" >&2
exit 1
