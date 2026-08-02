#!/usr/bin/env bash
# Give an E2E account the shared dev GitHub App installation, so cloud-agent
# scenarios can list repositories, clone, and push against real GitHub.
#
#   github-installation.sh <email> [installation-id] [account-login]
#
# Defaults to the shared dev installation (144771093, account iscekic).
# The script signs in as the account through next-auth fake-login and calls
# the dev-only tRPC mutation `githubApps.devAddInstallation`, which reads the
# installation from real GitHub with the App's own credentials and writes the
# user's platform integration plus its repository list.
#
# This writes the INSTALLATION (platform_integrations), not the user's OAuth
# token row. It never touches `user_github_app_tokens`, so it coexists with
# github-stub.sh. It also ignores GITHUB_API_BASE_URL: the integration adapter
# always talks to api.github.com.
#
# Re-running is safe: the mutation upserts the same rows. Pass the exact
# sign-in email: fake-login CREATES the account when it does not exist, so a
# typo adds a junk account to the shared dev database instead of failing.
# After it succeeds, relaunch the app so the repository query refetches.
set -euo pipefail

EMAIL="${1:?usage: github-installation.sh <email> [installation-id] [account-login]}"
INSTALLATION_ID="${2:-144771093}"
ACCOUNT_LOGIN="${3:-iscekic}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"

# Read the live port; a worktree's nextjs never sits on a default port.
API_PORT="$(cd "$REPO_ROOT" && pnpm -s dev:status --json | node -e '
const status = JSON.parse(require("fs").readFileSync(0, "utf8"));
const service = status.services.find(s => s.name === "nextjs");
if (service && service.status === "up" && service.port) process.stdout.write(String(service.port));
')"
[ -n "$API_PORT" ] || {
  echo "github-installation: nextjs is not up in this worktree; start the stack first" >&2
  exit 1
}
BASE="http://127.0.0.1:$API_PORT"

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kilo-e2e-github-installation.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "github-installation: failed at $1 for $EMAIL (HTTP ${2:-?})${3:+: $3}" >&2
  exit 1
}

# The nextjs API is slow under full parallel load, and the mutation makes two
# round-trips to GitHub, so every call gets a generous --max-time.
JAR="$WORK_DIR/jar"
CSRF=$(curl -s --max-time 120 -c "$JAR" "$BASE/api/auth/csrf" \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).csrfToken)') \
  || fail csrf "$(curl -s --max-time 120 -o /dev/null -w '%{http_code}' "$BASE/api/auth/csrf")"
CODE=$(curl -s --max-time 120 -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" \
  -X POST "$BASE/api/auth/callback/fake-login" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "email=$EMAIL" \
  --data-urlencode "json=true") || fail fake-login transport
case $CODE in 2* | 3*) ;; *) fail fake-login "$CODE" ;; esac

BODY="$WORK_DIR/body"
CODE=$(curl -s --max-time 120 -o "$BODY" -w '%{http_code}' -b "$JAR" \
  -X POST "$BASE/api/trpc/githubApps.devAddInstallation" \
  -H 'content-type: application/json' \
  -d "{\"installationId\":\"$INSTALLATION_ID\",\"accountLogin\":\"$ACCOUNT_LOGIN\"}") \
  || fail trpc-add-installation transport
case $CODE in 2*) ;; *) fail trpc-add-installation "$CODE" "$(cut -c1-300 "$BODY")" ;; esac
grep -q '"error"' "$BODY" && fail trpc-add-installation "$CODE" "$(cut -c1-300 "$BODY")"
grep -q '"success":true' "$BODY" || fail trpc-add-installation "$CODE" "$(cut -c1-300 "$BODY")"

# `success:true` only proves the mutation ran. The upsert keys on the
# installation id, so a second id gives the account a second github row, and
# the two readers can then disagree: the installation screen orders by health
# and recency, while the cloud-agent repository list takes one row with no
# ordering. Assert both, because only the second one is what a cloud-agent
# scenario depends on.
CHECK="$WORK_DIR/check"
CODE=$(curl -s --max-time 120 -o "$CHECK" -w '%{http_code}' -b "$JAR" \
  "$BASE/api/trpc/githubApps.getInstallation") || fail readback transport
case $CODE in 2*) ;; *) fail readback "$CODE" "$(cut -c1-300 "$CHECK")" ;; esac
read -r LIVE_ID INSTALLED <<<"$(node -e '
const response = JSON.parse(require("fs").readFileSync(0, "utf8"));
const data = response.result?.data?.json ?? response.result?.data;
const installation = data?.installation;
if (!installation) process.exit(0);
process.stdout.write(`${installation.installationId} ${data.installed}`);
' < "$CHECK")"
[ "$LIVE_ID" = "$INSTALLATION_ID" ] && [ "$INSTALLED" = "true" ] \
  || fail readback "$CODE" "the account resolves installation ${LIVE_ID:-none} (installed=${INSTALLED:-none}), not $INSTALLATION_ID — check the account's github integration rows"

# The unordered reader: `fetchGitHubRepositoriesForUser` is what the mobile
# new-session screen calls, so an empty list here means the app cannot start a
# cloud agent even when the installation screen looks right.
REPOS="$WORK_DIR/repos"
CODE=$(curl -s --max-time 120 -o "$REPOS" -w '%{http_code}' -b "$JAR" -G \
  --data-urlencode 'input={"forceRefresh":false}' \
  "$BASE/api/trpc/cloudAgentNext.listGitHubRepositories") || fail repo-readback transport
case $CODE in 2*) ;; *) fail repo-readback "$CODE" "$(cut -c1-300 "$REPOS")" ;; esac
REPO_COUNT="$(node -e '
const response = JSON.parse(require("fs").readFileSync(0, "utf8"));
const data = response.result?.data?.json ?? response.result?.data;
if (!data?.integrationInstalled || !Array.isArray(data.repositories)) process.exit(0);
process.stdout.write(String(data.repositories.length));
' < "$REPOS")"
[ "${REPO_COUNT:-0}" -gt 0 ] \
  || fail repo-readback "$CODE" "the cloud-agent repository list is empty; that reader picks one of the account's github rows without ordering, so remove any other row"

echo "github-installation: installation $INSTALLATION_ID ($ACCOUNT_LOGIN) added for $EMAIL, $REPO_COUNT repositories"
echo "github-installation: relaunch the app now so the repository query refetches"
