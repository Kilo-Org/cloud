#!/usr/bin/env bash
# The deploy workflows' db-gate: asks the migration proxy (services/migration-proxy) to apply the
# shared Postgres migrations at TARGET_SHA and waits for the run (contract §8). The job's GitHub
# OIDC token, with the proxy's audience, is its only credential; a fresh one goes with every
# request. The script prints only RunView and status fields, never a token.
#
# Env: MIGRATION_PROXY_URL, MIGRATION_PROXY_AUDIENCE, TARGET_SHA, and the runner's
# ACTIONS_ID_TOKEN_REQUEST_URL / ACTIONS_ID_TOKEN_REQUEST_TOKEN (job permission id-token: write).
set -euo pipefail

: "${MIGRATION_PROXY_URL:?MIGRATION_PROXY_URL is required}"
: "${MIGRATION_PROXY_AUDIENCE:?MIGRATION_PROXY_AUDIENCE is required}"
: "${TARGET_SHA:?TARGET_SHA is required}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?ACTIONS_ID_TOKEN_REQUEST_URL is missing: the job needs id-token: write}"
: "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?ACTIONS_ID_TOKEN_REQUEST_TOKEN is missing: the job needs id-token: write}"

if [[ ! $TARGET_SHA =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::TARGET_SHA must be 40 lowercase hex characters" >&2
  exit 1
fi

readonly UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
readonly BUSY_MIN_SECONDS=30
readonly DEFAULT_POLL_SECONDS=20

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

# jq helpers: a printable field (control characters replaced, so a value cannot start a new log
# line or a workflow command) and a wait in seconds, bounded to 1..3600.
# shellcheck disable=SC2016 # a jq program: $default is jq's, not the shell's
readonly JQ_DEFS='
  def clean: tostring | explode | map(if . < 32 or . == 127 then 63 else . end) | implode;
  def seconds($default): if type == "number" and . >= 1 and . <= 3600 then floor else $default end;
'

# A fresh OIDC token for the proxy audience. Both bearer values reach curl on stdin (-H @-), so
# neither appears in a process argument list or in the log.
oidc_token() {
  local audience token
  audience="$(jq -rn --arg a "$MIGRATION_PROXY_AUDIENCE" '$a | @uri')"
  token="$(printf 'Authorization: bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
    curl -q -sS --fail --connect-timeout 10 --max-time 30 -H @- \
      "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${audience}" |
    jq -r '.value // empty')" || {
    echo "::error::could not get a GitHub OIDC token for the migration proxy" >&2
    return 1
  }
  if [[ -z $token ]]; then
    echo "::error::the GitHub OIDC token response held no token" >&2
    return 1
  fi
  printf '%s' "$token"
}

# One authenticated proxy request: the body lands in $body_file and the HTTP status in $status.
# A transport failure ends the job; the proxy keeps any run it started, and the next deploy finds
# it (busy, existing or already_applied).
proxy() {
  local method=$1 path=$2 data=${3-} token
  token="$(oidc_token)" || exit 1
  local args=(-q -sS -o "$body_file" -w '%{http_code}' --connect-timeout 10 --max-time 60
    -X "$method" -H @-)
  if [[ -n $data ]]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$data")
  fi
  status="$(printf 'Authorization: Bearer %s\n' "$token" |
    curl "${args[@]}" "${MIGRATION_PROXY_URL%/}${path}")" || {
    echo "::error::migration proxy request failed: $method $path" >&2
    exit 1
  }
}

# A field of the response body; a body that is not JSON (an edge error page) reads as null.
body() { jq -r "$JQ_DEFS $1" "$body_file" 2>/dev/null || jq -rn "$JQ_DEFS null | $1"; }

# One line per view: the RunView fields that say where the run is.
print_view() {
  jq -r "$JQ_DEFS"'
    "run \(.id | clean) \(.environment | clean): \(.state | clean)/\(.phase | clean)"
    + " sha=\(.sha | clean) attested=\(.attestedSha | clean)"
    + " pending=\(.pending | length) applied=\(.applied | length)"
    + (if .heartbeatAt == null then "" else " heartbeat=\(.heartbeatAt | clean)" end)
  ' <<<"$1"
}

# The final view: the applied and pending migrations and, for a failure, every failure field.
print_final() {
  jq -r "$JQ_DEFS"'
    "run \(.id | clean) \(.state | clean): created=\(.createdAt | clean)"
      + " started=\(.startedAt | clean) finished=\(.finishedAt | clean)",
    (.applied[] | "  applied \(.tag | clean) \(.hash | clean) \(.createdAt | clean)"),
    (.pending[] | "  pending \(. | clean)"),
    (.failure // empty
      | "  failure code=\(.code | clean) retryable=\(.retryable | clean)"
        + (if .reason == null then "" else " reason=\(.reason | clean)" end)
        + " sqlstate=\(.sqlstate | clean) migrationTag=\(.migrationTag | clean)",
        ((.indexes // [])[] | "  invalid index \(. | clean)"),
        ((.files // [])[] | "  file \(.path | clean) reason=\(.reason | clean) pr=\(.pr | clean)"))
  ' <<<"$1"
}

# Polls GET /v1/runs/{id} every pollAfterSeconds until the run is final; prints the final view.
wait_for_run() {
  local view=$1 id state last=''
  id="$(jq -r '.id' <<<"$view")"
  if [[ ! $id =~ $UUID_RE ]]; then
    echo "::error::the migration proxy answered a run without a valid id" >&2
    exit 1
  fi
  while :; do
    local line
    line="$(print_view "$view")"
    if [[ $line != "$last" ]]; then
      echo "$line"
      last=$line
    fi
    state="$(jq -r '.state' <<<"$view")"
    if [[ $state == succeeded || $state == failed ]]; then
      final_view=$view
      print_final "$view"
      return
    fi
    sleep "$(jq -r "$JQ_DEFS .pollAfterSeconds | seconds($DEFAULT_POLL_SECONDS)" <<<"$view")"
    proxy GET "/v1/runs/$id"
    case $status in
      200) view="$(cat "$body_file")" ;;
      503)
        echo "migration proxy unavailable ($(body '.reason | clean')); polling again"
        sleep "$(body ".retryAfterSeconds | seconds($DEFAULT_POLL_SECONDS)")"
        ;;
      *) fail_status "GET /v1/runs/$id" ;;
    esac
  done
}

# A refusal that ends the job: the status and its documented fields, nothing else of the body.
fail_status() {
  local what=$1 summary
  summary="$(jq -r "$JQ_DEFS"'
    if type == "object" then
      [ "status=\(.status | clean)",
        (if .reason == null then empty else "reason=\(.reason | clean)" end),
        (if .attemptedSha == null then empty else "attemptedSha=\(.attemptedSha | clean)" end)
      ] | join(" ")
    else "" end
  ' "$body_file" 2>/dev/null || true)"
  echo "::error::migration proxy refused $what: HTTP $status $summary" >&2
  case $summary in
    *reason=sha_behind_attempted* | *reason=sha_diverged*)
      echo "A newer commit was already attempted, so this target is stale. Dispatch the deploy" \
        "again; check-deployment-changes picks the newest CI-green commit. If that attempt failed" \
        "for good, fix forward with a new commit. Never deploy the older commit by hand." >&2
      ;;
    *status=config_invalid*)
      echo "The proxy refuses its own configuration; fix services/migration-proxy/wrangler.jsonc" \
        "in a reviewed PR." >&2
      ;;
  esac
  exit 1
}

# §8: the first POST plus at most one re-POST after a retryable failure; busy, 429 and 503 waits
# create no run and re-POST once per retryAfterSeconds until the job's timeout.
request_body="$(jq -cn --arg sha "$TARGET_SHA" '{sha: $sha}')"
reposted=false
while :; do
  proxy POST /v1/runs "$request_body"
  case $status in
    200 | 202)
      outcome="$(body '.status | clean')"
      view="$(jq -c '.run' "$body_file")"
      echo "migration proxy: $outcome"
      if [[ $outcome == already_applied ]]; then
        print_view "$view"
        exit 0
      fi
      final_view=''
      wait_for_run "$view"
      if [[ "$(jq -r '.state' <<<"$final_view")" == succeeded ]]; then
        exit 0
      fi
      code="$(jq -r "$JQ_DEFS"' .failure.code | clean' <<<"$final_view")"
      if [[ "$(jq -r '.failure.retryable' <<<"$final_view")" == true && $reposted == false ]]; then
        reposted=true
        echo "migration run failed with retryable $code; starting one more run"
        continue
      fi
      echo "::error::migration run failed: $code" >&2
      exit 1
      ;;
    409)
      active="$(body '.activeRunId | clean')"
      wait_seconds="$(body ".retryAfterSeconds | seconds($BUSY_MIN_SECONDS)")"
      ((wait_seconds < BUSY_MIN_SECONDS)) && wait_seconds=$BUSY_MIN_SECONDS
      echo "migration proxy busy with run $active; retrying in ${wait_seconds}s"
      sleep "$wait_seconds"
      if [[ $active =~ $UUID_RE ]]; then
        proxy GET "/v1/runs/$active"
        if [[ $status == 200 ]]; then
          print_view "$(cat "$body_file")"
        fi
      fi
      ;;
    429 | 503)
      echo "migration proxy $(body '.status | clean') ($(body '.reason | clean')); retrying"
      sleep "$(body ".retryAfterSeconds | seconds($BUSY_MIN_SECONDS)")"
      ;;
    *) fail_status "POST /v1/runs" ;;
  esac
done
