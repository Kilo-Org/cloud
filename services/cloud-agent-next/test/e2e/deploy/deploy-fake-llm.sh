#!/usr/bin/env bash
set -euo pipefail
set +x
# Wrangler 4 also writes its logger output to log files by default; none here.
export WRANGLER_WRITE_LOGS=false

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
# Rendered from test/e2e/wrangler.fake-llm.jsonc with the one Access custom domain.
CONFIG_PATH="test/e2e/.wrangler/wrangler.fake-llm.jsonc"
RENDER_SCRIPT="test/e2e/deploy/render-e2e-worker-config.mjs"
FENCE_SCRIPT="test/e2e/deploy/e2e-worker-fence.mjs"
ACCESS_CHECK_SCRIPT="$SCRIPT_DIR/check-access-closed.sh"
WORKER_URL=""
ADMIN_TOKEN_VAR="FAKE_LLM_ADMIN_TOKEN"
ADMIN_TOKEN=""
CONTROL_ROUTE="test/requests"

print_command() {
  local arg
  local sep=""
  printf '+ ' >&2
  for arg in "$@"; do
    printf '%s%q' "$sep" "$arg" >&2
    sep=" "
  done
  printf '\n' >&2
}

run_service_command() {
  print_command cd "$SERVICE_DIR" '&&' "$@"
  (cd "$SERVICE_DIR" && "$@")
}

usage() {
  cat <<USAGE
Usage: deploy-fake-llm.sh <command>

Only the reviewed Cloud Agent E2E workflow deploys: Cloudflare writes for the
test Workers never use a personal login. Locally, use render and dry-run.

Commands:
  render    Render test/e2e/.wrangler/wrangler.fake-llm.jsonc with the one Access custom domain
            and run the fence on it
  dry-run   Render and fence, then run wrangler deploy --dry-run
  deploy    Render and fence, deploy, upload the admin token, then check that Access refuses an
            anonymous request to the hostname
  probe     Check that Access refuses an anonymous request, then, with the Access service token:
            /health answers, the model catalogue and /${CONTROL_ROUTE} refuse a missing bearer,
            and /${CONTROL_ROUTE} accepts the admin bearer
  help      Show this help

Required environment (every command except help):
  E2E_FAKE_LLM_HOSTNAME  The fake-LLM Worker's only hostname: a custom domain that its own
                         Access application (fake-llm-e2e-test) already protects. There is no
                         default; without it the script refuses before rendering or uploading
                         anything.
Required for render, dry-run and deploy:
  E2E_FAKE_LLM_ACCESS_AUD, E2E_ACCESS_TEAM_DOMAIN
                       The fake LLM's Access audience tag and <team>.cloudflareaccess.com; the
                       Worker refuses every request whose assertion does not verify against them.
Required for deploy and probe:
  ${ADMIN_TOKEN_VAR}  Bearer the Worker requires on every /test/* route. Export the same
                       value for the E2E driver. When unset or empty, the script reads
                       the fakeLlmAdminToken field of E2E_AUTH_FILE instead. deploy also
                       requires at least 16 characters, no whitespace, and not the
                       insecure development default used by a zero-config local stack.
Required for probe:
  E2E_ACCESS_CLIENT_ID, E2E_ACCESS_CLIENT_SECRET
                       The Access service token from the STS ci-cloud-agent-e2e bundle.

Optional environment:
  E2E_AUTH_FILE        Deployed-run JSON file. Its fakeLlmAdminToken field is used
                       when ${ADMIN_TOKEN_VAR} is unset or empty.
USAGE
}

# Read the development default from its single source of truth so this guard
# cannot drift from the Worker and the driver.
dev_default_admin_token() {
  (cd "$SERVICE_DIR" && pnpm exec tsx -e \
    "import { LOCAL_FAKE_LLM_ADMIN_TOKEN } from './test/e2e/fake-llm-admin.js'; console.log(LOCAL_FAKE_LLM_ADMIN_TOKEN);")
}

admin_token_source_hint() {
  printf 'Set %s, or set E2E_AUTH_FILE to a JSON file with a non-empty string "fakeLlmAdminToken".\n' \
    "$ADMIN_TOKEN_VAR" >&2
}

read_auth_file_admin_token() {
  node -e '
const fs = require("node:fs");
const file = process.argv[1];
let text;
try {
  text = fs.readFileSync(file, "utf8");
} catch (error) {
  process.stderr.write(`Cannot read ${file}: ${error.message}\n`);
  process.exit(1);
}
let document;
try {
  document = JSON.parse(text);
} catch {
  process.stderr.write(`${file} is not valid JSON.\n`);
  process.exit(1);
}
const token = document && typeof document === "object" ? document.fakeLlmAdminToken : undefined;
if (typeof token !== "string" || token.length === 0) {
  process.stderr.write(`${file} must contain a non-empty string "fakeLlmAdminToken".\n`);
  process.exit(1);
}
process.stdout.write(`${token}\u0001`);
' "$1"
}

# Resolve the admin token. This is the single owner of the resolution order.
resolve_admin_token() {
  if [[ -n "${FAKE_LLM_ADMIN_TOKEN:-}" ]]; then
    ADMIN_TOKEN="$FAKE_LLM_ADMIN_TOKEN"
    return
  fi

  if [[ -z "${E2E_AUTH_FILE:-}" ]]; then
    printf '%s is not set and E2E_AUTH_FILE is not set.\n' "$ADMIN_TOKEN_VAR" >&2
    admin_token_source_hint
    exit 1
  fi

  local token
  if ! token=$(read_auth_file_admin_token "$E2E_AUTH_FILE"); then
    printf 'Refusing to continue: could not read fakeLlmAdminToken from E2E_AUTH_FILE=%s.\n' \
      "$E2E_AUTH_FILE" >&2
    exit 1
  fi
  # The reader appends one sentinel byte so a trailing newline in the file value
  # survives command substitution and stays visible to the whitespace check.
  ADMIN_TOKEN="${token%$'\001'}"
}

require_admin_token() {
  resolve_admin_token

  local token="$ADMIN_TOKEN"
  if [[ -z "$token" ]]; then
    printf '%s is required and must not be empty.\n' "$ADMIN_TOKEN_VAR" >&2
    admin_token_source_hint
    exit 1
  fi

  local dev_default
  if ! dev_default=$(dev_default_admin_token) || [[ -z "$dev_default" ]]; then
    printf 'Refusing to continue: could not read the development default admin token.\n' >&2
    exit 1
  fi
  if [[ "$token" == "$dev_default" ]]; then
    printf 'Refusing to use the insecure development default %s: %s\n' "$ADMIN_TOKEN_VAR" "$dev_default" >&2
    admin_token_source_hint
    exit 1
  fi

  if (( ${#token} < 16 )); then
    printf '%s must be at least 16 characters.\n' "$ADMIN_TOKEN_VAR" >&2
    admin_token_source_hint
    exit 1
  fi
  if [[ "$token" =~ [[:space:]] ]]; then
    printf '%s must not contain whitespace (leading, trailing or internal).\n' "$ADMIN_TOKEN_VAR" >&2
    admin_token_source_hint
    exit 1
  fi
}

# Never print the secret value: the redacted line names the variable instead.
upload_admin_token() {
  printf '+ printf %%s "[redacted]" | pnpm exec wrangler secret put %s --config %s\n' \
    "$ADMIN_TOKEN_VAR" "$CONFIG_PATH" >&2
  (cd "$SERVICE_DIR" && printf '%s' "$ADMIN_TOKEN" | pnpm exec wrangler secret put "$ADMIN_TOKEN_VAR" --config "$CONFIG_PATH")
}

# The Worker has no address other than its Access hostname, so nothing may
# happen before that hostname is known: no render, no upload.
require_hostname() {
  if [[ ! "${E2E_FAKE_LLM_HOSTNAME:-}" =~ ^[a-z0-9.-]+$ ]] || [[ "$E2E_FAKE_LLM_HOSTNAME" == *workers.dev ]]; then
    printf 'E2E_FAKE_LLM_HOSTNAME must be the Access-protected hostname of the fake-LLM Worker; refusing before any upload.\n' >&2
    exit 1
  fi
  WORKER_URL="https://${E2E_FAKE_LLM_HOSTNAME}"
}

# Render the private config with the one custom domain and fence it.
render_config() {
  run_service_command node "$RENDER_SCRIPT" --fake-llm
  run_service_command node "$FENCE_SCRIPT" --fake-llm "$CONFIG_PATH"
}

require_access_token() {
  if [[ -z "${E2E_ACCESS_CLIENT_ID:-}" || -z "${E2E_ACCESS_CLIENT_SECRET:-}" ]]; then
    printf 'E2E_ACCESS_CLIENT_ID and E2E_ACCESS_CLIENT_SECRET are required (the STS ci-cloud-agent-e2e bundle).\n' >&2
    exit 1
  fi
}

# curl config lines for the Access service token and, optionally, the admin
# bearer. Values reach curl over stdin (`--config -`), never as argv elements,
# which are readable from `ps` / `/proc/<pid>/cmdline` while a request runs.
curl_header_lines() {
  local with_admin="$1" value
  for value in "CF-Access-Client-Id: ${E2E_ACCESS_CLIENT_ID}" "CF-Access-Client-Secret: ${E2E_ACCESS_CLIENT_SECRET}"; do
    value=${value//\\/\\\\}
    printf 'header = "%s"\n' "${value//\"/\\\"}"
  done
  if [[ "$with_admin" == admin ]]; then
    value=${ADMIN_TOKEN//\\/\\\\}
    printf 'header = "Authorization: Bearer %s"\n' "${value//\"/\\\"}"
  fi
}

# One request through Access; prints the status. A redirect is never followed.
expect_status() {
  local expected="$1" with_admin="$2" path="$3" status
  printf '+ curl --config - (Access token%s) %s%s\n' "${with_admin:+ and admin bearer}" "$WORKER_URL" "$path" >&2
  status=$(curl_header_lines "$with_admin" |
    curl -s -o /dev/null -w '%{http_code}' --max-time 15 --config - "${WORKER_URL}${path}" || true)
  if [[ "$status" != "$expected" ]]; then
    printf 'Expected %s%s to return %s through Access, got %s\n' "$WORKER_URL" "$path" "$expected" "$status" >&2
    exit 1
  fi
  printf '%s: %s through Access\n' "$path" "$status"
}

# Authenticated checks through Access: the Worker answers, its model catalogue
# still requires a model bearer, and its /test/* side channel still requires the
# admin bearer and accepts it. Run by the workflow's proof job, which holds the
# Access token.
probe_checks() {
  expect_status 200 '' /health
  expect_status 401 '' /api/openrouter/models
  expect_status 401 '' "/${CONTROL_ROUTE}"
  expect_status 200 admin "/${CONTROL_ROUTE}"
}

main() {
  local command="${1:-help}"
  case "$command" in
    help | --help | -h)
      usage
      ;;
    render)
      require_hostname
      render_config
      printf 'worker url: %s\n' "$WORKER_URL"
      ;;
    dry-run)
      require_hostname
      render_config
      run_service_command pnpm exec wrangler deploy --dry-run --config "$CONFIG_PATH"
      ;;
    deploy)
      require_hostname
      require_admin_token
      render_config
      run_service_command pnpm exec wrangler deploy --config "$CONFIG_PATH"
      upload_admin_token
      "$ACCESS_CHECK_SCRIPT" "$E2E_FAKE_LLM_HOSTNAME"
      ;;
    probe)
      require_hostname
      require_access_token
      resolve_admin_token
      if [[ -z "$ADMIN_TOKEN" ]]; then
        printf '%s is required and must not be empty.\n' "$ADMIN_TOKEN_VAR" >&2
        exit 1
      fi
      "$ACCESS_CHECK_SCRIPT" "$E2E_FAKE_LLM_HOSTNAME"
      probe_checks
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
