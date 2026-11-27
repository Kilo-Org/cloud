#!/usr/bin/env bash
# Asks R2 for temporary S3 credentials on the Cloud Agent runtime bucket, with the STS deploy token
# in CLOUDFLARE_API_TOKEN (its grant holds Workers R2 Storage Write), so a deploy or publish job
# never reads the stored CLOUD_AGENT_RUNTIME_R2_* keys
# (https://developers.cloudflare.com/r2/api/s3/temporary-credentials/).
#
#   r2-temp-credentials.sh   writes the step outputs `access_key_id`, `secret_access_key` and
#                            `session_token`
#
# Env: CLOUDFLARE_API_TOKEN, RUNTIME_R2_ACCOUNT_ID, RUNTIME_R2_BUCKET,
# RUNTIME_R2_PARENT_ACCESS_KEY_ID (the access key id of the R2 API token the credentials derive
# from; an id, not a secret), GITHUB_OUTPUT. The credentials last 1 hour, reach only keys under
# runtime-artifacts/v1/ of that bucket, read and write objects, and never exceed the parent
# token's rights. The secret key and the session token are masked before anything else touches
# them and never printed; no retry. Needs bash, curl and jq.
#
# Every request goes over HTTPS to https://api.cloudflare.com. Only the local tests set
# R2_TEMP_CREDENTIALS_TEST=1, which lets CLOUDFLARE_API_URL point at a stub and allows plain
# HTTP; the script refuses it inside GitHub Actions.
set -euo pipefail

readonly PREFIX=runtime-artifacts/v1/
readonly TTL_SECONDS=3600
# One line of printable ASCII: a newline would end the mask early and inject a step output.
readonly VALUE_JQ='^[!-~]+\z'

fail() {
  printf '::error::%s\n' "$1"
  exit 1
}

[[ $# -eq 0 ]] || fail "Usage: r2-temp-credentials.sh"

if [[ ${R2_TEMP_CREDENTIALS_TEST:-} == 1 ]]; then
  [[ ${GITHUB_ACTIONS:-} != true ]] || fail "R2_TEMP_CREDENTIALS_TEST is for local tests only"
  [[ -n ${CLOUDFLARE_API_URL:-} ]] || fail "R2_TEMP_CREDENTIALS_TEST needs CLOUDFLARE_API_URL"
  readonly PROTOCOLS='=http,https'
else
  CLOUDFLARE_API_URL=https://api.cloudflare.com/client/v4
  readonly PROTOCOLS='=https'
fi
readonly CLOUDFLARE_API_URL

[[ -n ${GITHUB_OUTPUT:-} ]] || fail "GITHUB_OUTPUT is not set"
[[ -n ${CLOUDFLARE_API_TOKEN:-} ]] || fail "CLOUDFLARE_API_TOKEN is not set"
[[ ${RUNTIME_R2_ACCOUNT_ID:-} =~ ^[0-9a-f]{32}$ ]] || fail "RUNTIME_R2_ACCOUNT_ID is not an account id"
[[ ${RUNTIME_R2_BUCKET:-} =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] ||
  fail "RUNTIME_R2_BUCKET is not a bucket name"
[[ ${RUNTIME_R2_PARENT_ACCESS_KEY_ID:-} =~ ^[0-9a-f]{32}$ ]] ||
  fail "RUNTIME_R2_PARENT_ACCESS_KEY_ID is not an R2 access key id"

body=$(jq -cn --arg bucket "$RUNTIME_R2_BUCKET" --arg parent "$RUNTIME_R2_PARENT_ACCESS_KEY_ID" \
  --arg prefix "$PREFIX" --argjson ttl "$TTL_SECONDS" \
  '{bucket: $bucket, parentAccessKeyId: $parent, permission: "object-read-write",
    ttlSeconds: $ttl, prefixes: [$prefix]}')

# The bearer goes to curl on stdin, so the token appears in no process's arguments.
response=$(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" |
  curl -sS --proto "$PROTOCOLS" --connect-timeout 10 --max-time 60 -H @- \
    -H 'content-type: application/json' --data "$body" -w '\n%{http_code}' \
    "$CLOUDFLARE_API_URL/accounts/$RUNTIME_R2_ACCOUNT_ID/r2/temp-access-credentials") ||
  fail "Cloudflare is unreachable (curl exit $?)"
status=${response##*$'\n'}
answer=$(printf '%s' "${response%$'\n'*}" | jq -cs 'if length == 1 then .[0] else null end' \
  2>/dev/null || printf 'null')

# Reads one field of the result as a one-line value, or nothing.
field() {
  printf '%s' "$answer" | jq -r --arg name "$1" --arg pattern "$VALUE_JQ" \
    '.result[$name] | select(type == "string" and test($pattern))' 2>/dev/null || true
}

# Masks every value it can read before it looks at anything else: the answer may be partial.
secret=$(field secretAccessKey)
session=$(field sessionToken)
[[ -z $secret ]] || printf '::add-mask::%s\n' "$secret"
[[ -z $session ]] || printf '::add-mask::%s\n' "$session"
key_id=$(field accessKeyId)

if [[ $status != 200 || -z $key_id || -z $secret || -z $session ]] ||
  ! printf '%s' "$answer" | jq -e '.success == true' >/dev/null 2>&1; then
  # Cloudflare's error codes only, never the body: a body of the wrong shape can hold a credential.
  codes=$(printf '%s' "$answer" | jq -r '[.errors[]?.code | numbers] | map(tostring) | join(",")' \
    2>/dev/null || true)
  fail "R2 issued no temporary credentials (HTTP $status${codes:+, codes $codes})"
fi

{
  printf 'access_key_id=%s\n' "$key_id"
  printf 'secret_access_key=%s\n' "$secret"
  printf 'session_token=%s\n' "$session"
} >>"$GITHUB_OUTPUT"
printf 'R2 issued temporary credentials on %s for %s s\n' "$RUNTIME_R2_BUCKET" "$TTL_SECONDS"
