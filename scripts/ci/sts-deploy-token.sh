#!/usr/bin/env bash
# Gets a Cloudflare deploy token from STS for this GitHub Actions job, or revokes it. The token
# lasts the policy's ttlSeconds, at most 1 hour (services/sts/README.md, "Cloudflare deploy
# tokens"). It never prints a token: `mint` masks the token in the job log before anything else
# touches it and hands it on only as the step output `token`. Ported from Kilo-Org/bouncer's
# scripts/ci/sts-deploy-token.sh; the one change is STS_ENVIRONMENT.
#
#   sts-deploy-token.sh mint          writes the step outputs `token_id`, then `token`
#   sts-deploy-token.sh revoke <id>   revokes the token with that id
#
# STS_ENVIRONMENT names the STS that holds the job's policy: `production`
# (https://sts.kiloapps.io) or `staging` (https://sts-staging.kiloapps.io). It is both the OIDC
# audience and the host every request goes to.
#
# Each call exchanges a fresh GitHub OIDC token (the job needs `permissions: id-token: write`).
# Any refusal, malformed answer or unreachable STS fails the call with the reason; nothing retries,
# because every mint request counts against the policy's limits. Needs bash, curl and jq.
#
# Every request goes over HTTPS to that STS. Only the local tests set STS_DEPLOY_TOKEN_TEST=1,
# which lets STS_URL point at a stub and allows plain HTTP; the script refuses it inside GitHub
# Actions. The OIDC audience never changes.
set -euo pipefail

case ${STS_ENVIRONMENT:-} in
  production) readonly AUDIENCE=https://sts.kiloapps.io ;;
  staging) readonly AUDIENCE=https://sts-staging.kiloapps.io ;;
  *)
    printf '::error::STS_ENVIRONMENT must be production or staging\n'
    exit 1
    ;;
esac
readonly MINT_PATH=/v1/ci/cloudflare-deploy-token
readonly REVOKE_PATH=/v1/ci/cloudflare-deploy-token/revoke
# Cloudflare's token id, for bash. The jq patterns end in \z: their $ also matches before a
# final newline.
readonly TOKEN_ID_PATTERN='^[0-9a-f]{32}$'
readonly TOKEN_ID_JQ='^[0-9a-f]{32}\z'
# One line of printable ASCII: a newline would end the mask early and inject a step output.
readonly TOKEN_JQ='^[!-~]+\z'

fail() {
  printf '::error::%s\n' "$1"
  exit 1
}

usage() {
  fail "Usage: sts-deploy-token.sh mint | revoke <token id>"
}

if [[ ${STS_DEPLOY_TOKEN_TEST:-} == 1 ]]; then
  [[ ${GITHUB_ACTIONS:-} != true ]] || fail "STS_DEPLOY_TOKEN_TEST is for local tests only"
  [[ -n ${STS_URL:-} ]] || fail "STS_DEPLOY_TOKEN_TEST needs STS_URL"
  readonly PROTOCOLS='=http,https'
else
  STS_URL=$AUDIENCE
  readonly PROTOCOLS='=https'
fi
readonly STS_URL

# Prints stdin as one compact JSON value, or `null` unless it is exactly one JSON value. jq reads a
# stream, so two concatenated objects would each pass every check and print two values.
single_json() {
  jq -cs 'if length == 1 then .[0] else null end' 2>/dev/null || printf 'null'
}

# Sets OIDC to a fresh GitHub OIDC token for the STS audience and masks it: anyone who reads it
# can ask STS for a deploy token until it expires.
fetch_oidc() {
  if [[ -z ${ACTIONS_ID_TOKEN_REQUEST_URL:-} || -z ${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-} ]]; then
    fail "No GitHub OIDC token: the job needs permissions: id-token: write"
  fi
  local answer
  # Every bearer goes to curl on stdin, so no token appears in a process's arguments.
  answer=$(printf 'Authorization: Bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
    curl -sS --fail --proto "$PROTOCOLS" --connect-timeout 10 --max-time 30 -H @- -G \
      --data-urlencode "audience=$AUDIENCE" "$ACTIONS_ID_TOKEN_REQUEST_URL") ||
    fail "GitHub did not issue an OIDC token"
  answer=$(printf '%s' "$answer" | single_json)
  OIDC=$(printf '%s' "$answer" | jq -r --arg pattern "$TOKEN_JQ" \
    '.value | select(type == "string" and test($pattern))' 2>/dev/null) || OIDC=""
  [[ -n $OIDC && $OIDC != *$'\n'* ]] || fail "GitHub answered without an OIDC token"
  printf '::add-mask::%s\n' "$OIDC"
}

# POSTs the JSON body $2 to the STS path $1 with a fresh OIDC token. Sets HTTP_STATUS and BODY.
sts_post() {
  fetch_oidc
  local response
  response=$(printf 'Authorization: Bearer %s\n' "$OIDC" |
    curl -sS --proto "$PROTOCOLS" --connect-timeout 10 --max-time 60 -H @- \
      -H 'content-type: application/json' --data "$2" -w '\n%{http_code}' "$STS_URL$1") ||
    fail "STS is unreachable (curl exit $?)"
  HTTP_STATUS=${response##*$'\n'}
  BODY=$(printf '%s' "${response%$'\n'*}" | single_json)
}

# Fails with $1 and STS's status, reason and retry time. Never prints the body: an answer of the
# wrong shape can still hold a token.
refuse() {
  local detail
  detail=$(printf '%s' "$BODY" | jq -r '
    def word: select(type == "string" and test("^[a-z_]{1,40}\\z"));
    select(type == "object" and .status != "ok" and .status != "revoked")
    | [(.status | word), (.reason | word), (.retryAfterSeconds | numbers | "retry after \(.) s")]
    | select(length > 0)
    | join(", ")' 2>/dev/null) || detail=""
  fail "$1 (HTTP $HTTP_STATUS: ${detail:-malformed answer})"
}

mint() {
  [[ -n ${GITHUB_OUTPUT:-} ]] || fail "GITHUB_OUTPUT is not set"
  sts_post "$MINT_PATH" '{}'
  local token token_id
  # Any one-line token is masked first, whatever the rest of the answer: a minted token whose id
  # is unusable cannot be revoked and stays valid until STS deletes it at its expiry.
  token=$(printf '%s' "$BODY" | jq -r --arg pattern "$TOKEN_JQ" \
    '.token | select(type == "string" and test($pattern))' 2>/dev/null) || token=""
  # A value with a newline is refused unmasked: masking it would cover only its first line.
  if [[ $token == *$'\n'* ]]; then
    token=""
  elif [[ -n $token ]]; then
    printf '::add-mask::%s\n' "$token"
  fi
  if [[ $HTTP_STATUS != 200 || -z $token ]] || ! printf '%s' "$BODY" | jq -e \
    --arg id "$TOKEN_ID_JQ" '.status == "ok" and (.tokenId | type == "string" and test($id))' \
    >/dev/null 2>&1; then
    refuse "STS issued no deploy token"
  fi
  token_id=$(printf '%s' "$BODY" | jq -r .tokenId)
  [[ $token_id =~ $TOKEN_ID_PATTERN ]] || refuse "STS issued no deploy token"
  # The id first: if writing the token fails, the revoke step still finds the id.
  printf 'token_id=%s\n' "$token_id" >>"$GITHUB_OUTPUT"
  printf 'token=%s\n' "$token" >>"$GITHUB_OUTPUT"
  printf 'STS issued deploy token %s\n' "$token_id"
}

revoke() {
  local token_id=$1
  [[ $token_id =~ $TOKEN_ID_PATTERN ]] || fail "Not a deploy token id; nothing was sent"
  sts_post "$REVOKE_PATH" "{\"tokenId\":\"$token_id\"}"
  if [[ $HTTP_STATUS != 200 ]] || ! printf '%s' "$BODY" | jq -e --arg id "$token_id" \
    '.status == "revoked" and .tokenId == $id' >/dev/null 2>&1; then
    refuse "STS did not revoke deploy token $token_id"
  fi
  printf 'STS revoked deploy token %s\n' "$token_id"
}

case ${1:-} in
  mint)
    [[ $# -eq 1 ]] || usage
    mint
    ;;
  revoke)
    [[ $# -eq 2 ]] || usage
    revoke "$2"
    ;;
  *) usage ;;
esac
