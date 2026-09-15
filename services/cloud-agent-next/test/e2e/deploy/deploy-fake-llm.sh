#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
CONFIG_PATH="test/e2e/wrangler.fake-llm.jsonc"
FAKE_LLM_WORKER_URL="${FAKE_LLM_WORKER_URL:-https://fake-llm.engineering-e11.workers.dev}"
FAKE_LLM_BASE_URL="${FAKE_LLM_WORKER_URL}/api/openrouter"
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

run_command() {
  print_command "$@"
  "$@"
}

run_service_command() {
  print_command cd "$SERVICE_DIR" '&&' "$@"
  (cd "$SERVICE_DIR" && "$@")
}

usage() {
  cat <<USAGE
Usage: deploy-fake-llm.sh <command>

Commands:
  render    Print the config path, worker URL, derived FAKE_LLM_BASE_URL, and the required secret
  secret    Upload ${ADMIN_TOKEN_VAR} as the Worker secret (once, and after every rotation)
  dry-run   Run wrangler deploy --dry-run for the fake-llm Worker
  deploy    Deploy the Worker, upload the admin token, then health-check health and the control route
  health    Check /health, the model catalogue, and that /${CONTROL_ROUTE} is closed without a bearer
  help      Show this help

Required environment (every command except render, dry-run and help):
  ${ADMIN_TOKEN_VAR}  Bearer the Worker requires on every /test/* route. Export the same
                       value for the E2E driver. When unset or empty, the script reads
                       the fakeLlmAdminToken field of E2E_AUTH_FILE instead. Must be
                       non-empty, at least 16 characters, contain no whitespace, and
                       must not be the insecure development default used by a
                       zero-config local stack.

Optional environment:
  E2E_AUTH_FILE        Deployed-run JSON file. Its fakeLlmAdminToken field is used
                       when ${ADMIN_TOKEN_VAR} is unset or empty.
  FAKE_LLM_WORKER_URL  Defaults to https://fake-llm.engineering-e11.workers.dev
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

health_checks() {
  run_command curl -fsS --retry 10 --retry-delay 2 --retry-connrefused --max-time 15 "${FAKE_LLM_WORKER_URL}/health"

  # The model catalogue is JWT-gated: a bare probe must be rejected with 401,
  # which proves both that the route is live and that the bearer boundary holds.
  printf '+ curl -s -o /dev/null -w %%{http_code} %s/models\n' "$FAKE_LLM_BASE_URL" >&2
  local models_status
  models_status=$(curl -s -o /dev/null -w '%{http_code}' \
    --retry 10 --retry-delay 2 --retry-connrefused --max-time 15 "${FAKE_LLM_BASE_URL}/models")
  if [[ "$models_status" != "401" ]]; then
    printf 'Expected unauthenticated %s/models to return 401, got %s\n' "$FAKE_LLM_BASE_URL" "$models_status" >&2
    exit 1
  fi

  # The control surface must reject an unauthenticated request: the token is the
  # only thing standing between the public internet and the /test/* side channel.
  printf '+ curl -s -o /dev/null -w %%{http_code} %s/%s\n' "$FAKE_LLM_WORKER_URL" "$CONTROL_ROUTE" >&2
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${FAKE_LLM_WORKER_URL}/${CONTROL_ROUTE}")
  if [[ "$status" != "401" ]]; then
    printf 'Expected unauthenticated /%s to return 401, got %s\n' "$CONTROL_ROUTE" "$status" >&2
    exit 1
  fi

  printf '+ curl -fsS -H "Authorization: Bearer $%s" %s/%s\n' \
    "$ADMIN_TOKEN_VAR" "$FAKE_LLM_WORKER_URL" "$CONTROL_ROUTE" >&2
  curl -fsS --max-time 15 -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${FAKE_LLM_WORKER_URL}/${CONTROL_ROUTE}" >/dev/null
  printf 'Token accepted on /%s\n' "$CONTROL_ROUTE"

  printf 'FAKE_LLM_BASE_URL=%s\n' "$FAKE_LLM_BASE_URL"
}

main() {
  local command="${1:-help}"
  case "$command" in
    help | --help | -h)
      usage
      ;;
    render)
      printf 'config: %s/%s\n' "$SERVICE_DIR" "$CONFIG_PATH"
      printf 'worker url: %s\n' "$FAKE_LLM_WORKER_URL"
      printf 'FAKE_LLM_BASE_URL=%s\n' "$FAKE_LLM_BASE_URL"
      printf 'required secret: %s (Worker and E2E driver)\n' "$ADMIN_TOKEN_VAR"
      ;;
    secret)
      require_admin_token
      upload_admin_token
      ;;
    dry-run)
      run_service_command pnpm exec wrangler deploy --dry-run --config "$CONFIG_PATH"
      ;;
    deploy)
      require_admin_token
      run_service_command pnpm exec wrangler deploy --config "$CONFIG_PATH"
      upload_admin_token
      health_checks
      printf 'Pass FAKE_LLM_BASE_URL=%s and $%s to the e2e Worker render and the E2E driver.\n' \
        "$FAKE_LLM_BASE_URL" "$ADMIN_TOKEN_VAR"
      ;;
    health)
      require_admin_token
      health_checks
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"
