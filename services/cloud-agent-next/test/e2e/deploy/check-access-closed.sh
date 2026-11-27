#!/usr/bin/env bash
# Usage: check-access-closed.sh <hostname>
#
# Sends an anonymous GET to https://<hostname>/ and passes only when Cloudflare
# Access refuses it: a redirect to <team>.cloudflareaccess.com, or 401/403
# without the e2e Worker's own refusal marker. The Worker's marker means the
# request reached the Worker without passing Access, so the check fails at once.
# A freshly attached custom domain can take a moment to resolve and get its
# certificate, so any other outcome is retried a bounded number of times
# (ACCESS_CHECK_ATTEMPTS, default 6, ACCESS_CHECK_INTERVAL_S apart, default 10)
# and then fails.
set -euo pipefail

host="${1:-}"
if [[ ! "$host" =~ ^[a-z0-9.-]+$ ]]; then
  printf 'Usage: check-access-closed.sh <hostname>\n' >&2
  exit 2
fi
attempts="${ACCESS_CHECK_ATTEMPTS:-6}"
interval="${ACCESS_CHECK_INTERVAL_S:-10}"

headers=$(mktemp)
trap 'rm -f "$headers"' EXIT

for ((attempt = 1; attempt <= attempts; attempt++)); do
  : >"$headers"
  if result=$(curl -sS -o /dev/null -D "$headers" --max-time 30 -w '%{http_code} %{redirect_url}' "https://$host/"); then
    status="${result%% *}"
    location="${result#* }"
  else
    status="unreachable"
    location=""
  fi
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
  printf 'Attempt %s/%s: Access did not refuse https://%s/ (status %s).\n' "$attempt" "$attempts" "$host" "$status" >&2
  if ((attempt < attempts)); then sleep "$interval"; fi
done
printf 'Access did not refuse https://%s/ after %s attempts.\n' "$host" "$attempts" >&2
exit 1
