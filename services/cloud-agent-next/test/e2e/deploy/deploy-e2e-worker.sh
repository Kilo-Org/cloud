#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
CONFIG_PATH=".wrangler/wrangler.e2e-test.jsonc"
RENDER_SCRIPT="test/e2e/deploy/render-e2e-worker-config.mjs"
FENCE_SCRIPT="test/e2e/deploy/e2e-worker-fence.mjs"
ACCESS_CHECK_SCRIPT="$SCRIPT_DIR/check-access-closed.sh"
SOURCE_CONFIG_PATH="wrangler.runtime-generated.json"
CALLBACK_QUEUE="cloud-agent-next-callback-queue-e2e-test"
WORKER_NAME="cloud-agent-e2e-test"
INTERNAL_SECRET_VAR="INTERNAL_API_SECRET"
INTERNAL_SECRET=""
# The only Worker secrets the e2e Worker may hold. Secrets survive every deploy,
# so a name outside this set (a production credential left from an older
# render) stops the deploy until it is deleted.
ALLOWED_SECRETS="INTERNAL_API_SECRET E2E_ACCESS_CLIENT_ID E2E_ACCESS_CLIENT_SECRET"
# The Access service token is uploaded by an operator after the closed deploy,
# never by CI (README.md, Closed CI path); until then the Worker refuses all traffic.
REQUIRED_SECRETS="E2E_ACCESS_CLIENT_ID E2E_ACCESS_CLIENT_SECRET"

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

run_service_command_quiet() {
  print_command cd "$SERVICE_DIR" '&&' "$@"
  (cd "$SERVICE_DIR" && "$@") >/dev/null 2>&1
}

usage() {
  cat <<USAGE
Usage: deploy-e2e-worker.sh <command>

Only the reviewed Cloud Agent E2E workflow deploys: Cloudflare writes for the
test Workers never use a personal login. Locally, use render and dry-run.

Commands:
  render    Render .wrangler/wrangler.e2e-test.jsonc from wrangler.runtime-generated.json
            and run the fence on it
  dry-run   Render and fence, build the wrapper, and run wrangler deploy --dry-run
  deploy    Check the Worker's existing secrets, render and fence, build the wrapper, ensure
            the callback queue, deploy with the supplied secrets, check that Access refuses an
            anonymous request to the hostname, then list deployments

Required environment:
  E2E_FAKE_LLM_HOSTNAME  The fake-LLM Worker's Access-protected hostname. The Worker sends model
                         traffic and model validation to https://<it>/api/openrouter and stamps the
                         Access service token on those requests.
Required file:
  wrangler.runtime-generated.json from exact-SHA runtime deployment preparation
Optional environment:
  E2E_INTERNAL_API_SECRET Value deployed as the Worker's INTERNAL_API_SECRET when supplied. Needed
                          for the first deploy or a rotation; omit it on a redeploy to keep the
                          deployed value, which wrangler deploy never clears. The E2E driver always
                          requires it, so export the same value for a run. When unset or empty, the
                          script reads the e2eInternalApiSecret field of E2E_AUTH_FILE instead. Must
                          be at least 16 characters, contain no whitespace, and differ from
                          production's INTERNAL_API_SECRET. The last point is an operator requirement
                          the script cannot prove: it cannot read production's value.
  E2E_AUTH_FILE        Deployed-run JSON file. Its e2eInternalApiSecret field is used when
                       E2E_INTERNAL_API_SECRET is unset or empty.
  E2E_WORKER_HOSTNAME  Private hostname of the Worker: one custom domain that a Cloudflare Access
                       application must already protect (Service Auth only). Unset renders a
                       Worker with no address at all: workers.dev and preview URLs are always off.
                       Unsetting it does not detach a domain attached earlier (see README.md).
  E2E_ACCESS_AUD, E2E_ACCESS_TEAM_DOMAIN
                       Required with E2E_WORKER_HOSTNAME: the Access application's audience tag
                       and <team>.cloudflareaccess.com. The Worker refuses every request whose
                       Cf-Access-Jwt-Assertion does not verify against them.
Required Worker secrets:
  E2E_ACCESS_CLIENT_ID, E2E_ACCESS_CLIENT_SECRET
                       The Access service token, uploaded by an operator after the closed
                       deploy and its readback (README.md, Closed CI path). Without both the
                       deploy proceeds and prints a notice: the Worker refuses every request
                       until the upload. The script never uploads them.
USAGE
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf '%s is required\n' "$name" >&2
    exit 1
  fi
}

internal_secret_source_hint() {
  printf 'Set E2E_INTERNAL_API_SECRET, or set E2E_AUTH_FILE to a JSON file with a non-empty string "e2eInternalApiSecret".\n' >&2
  printf 'A source is needed for the first deploy or to rotate the value.\n' >&2
}

read_auth_file_internal_secret() {
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
const secret = document && typeof document === "object" ? document.e2eInternalApiSecret : undefined;
if (typeof secret !== "string" || secret.length === 0) {
  process.stderr.write(`${file} must contain a non-empty string "e2eInternalApiSecret".\n`);
  process.exit(1);
}
process.stdout.write(`${secret}\u0001`);
' "$1"
}

# Resolve the internal secret. This is the single owner of the resolution order.
# Returns 0 with INTERNAL_SECRET set when a source supplies a value, and 1 with
# INTERNAL_SECRET empty when no source is configured, so that a redeploy can keep
# the deployed value. A configured but unreadable source stays fatal.
resolve_internal_secret() {
  if [[ -n "${E2E_INTERNAL_API_SECRET:-}" ]]; then
    INTERNAL_SECRET="$E2E_INTERNAL_API_SECRET"
    return 0
  fi

  if [[ -z "${E2E_AUTH_FILE:-}" ]]; then
    INTERNAL_SECRET=""
    return 1
  fi

  local secret
  if ! secret=$(read_auth_file_internal_secret "$E2E_AUTH_FILE"); then
    printf 'Refusing to continue: could not read e2eInternalApiSecret from E2E_AUTH_FILE=%s.\n' \
      "$E2E_AUTH_FILE" >&2
    exit 1
  fi
  # The reader appends one sentinel byte so a trailing newline in the file value
  # survives command substitution and stays visible to the whitespace check.
  INTERNAL_SECRET="${secret%$'\001'}"
}

# Validate the resolved value with the single shared rule owner, so the driver,
# the renderer and this script cannot disagree about what is acceptable. The
# candidate is passed through the child environment, never as a command
# argument, so it is neither echoed nor visible in the process list.
validate_internal_secret() {
  (
    cd "$SERVICE_DIR" &&
      E2E_INTERNAL_SECRET_CANDIDATE="$INTERNAL_SECRET" pnpm exec tsx -e '
import { requireE2eInternalSecret } from "./test/e2e/e2e-internal-secret.js";
try {
  requireE2eInternalSecret(process.env.E2E_INTERNAL_SECRET_CANDIDATE, "E2E_INTERNAL_API_SECRET");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
'
  )
}

# The deploy secret contract. With a source, validate it with the shared rule owner
# and deploy it with the version. Without one, leave it out: wrangler deploy never
# clears an existing secret, so the deployed value survives. A secret that was never
# set makes the e2e surface reject every request with 401, which is loud and is fixed
# by `wrangler secret put` without another deploy.
prepare_internal_secret() {
  if ! resolve_internal_secret; then
    printf 'No %s source is set; keeping the deployed value.\n' "$INTERNAL_SECRET_VAR" >&2
    printf 'If it was never set, the e2e surface rejects every request with 401 until you set it.\n' >&2
    return
  fi
  if ! validate_internal_secret; then
    internal_secret_source_hint
    exit 1
  fi
}

# Refuse to deploy over a Worker that holds a secret outside ALLOWED_SECRETS. A
# missing Access service token only prints a notice: it is uploaded after the
# closed deploy, and the Worker refuses every request until then.
check_existing_secrets() {
  print_command cd "$SERVICE_DIR" '&&' pnpm exec wrangler secret list --name "$WORKER_NAME" --format json
  local listed
  listed=$(cd "$SERVICE_DIR" && pnpm exec wrangler secret list --name "$WORKER_NAME" --format json)
  SECRET_LIST="$listed" ALLOWED_SECRETS="$ALLOWED_SECRETS" REQUIRED_SECRETS="$REQUIRED_SECRETS" node -e '
const text = process.env.SECRET_LIST;
const names = JSON.parse(text.slice(text.indexOf("["))).map(secret => secret.name);
const allowed = new Set(process.env.ALLOWED_SECRETS.split(" "));
const unexpected = names.filter(name => !allowed.has(name));
if (unexpected.length > 0) {
  console.error(`Refusing to deploy: delete these Worker secrets first: ${unexpected.join(", ")}`);
  process.exit(1);
}
const missing = process.env.REQUIRED_SECRETS.split(" ").filter(name => !names.includes(name));
if (missing.length > 0) {
  console.log(
    `Notice: the Worker lacks ${missing.join(" and ")}, so it refuses every request until an operator ` +
      "uploads them after this deploy (test/e2e/deploy/README.md, Closed CI path)."
  );
}
console.log(`Worker secrets: ${names.join(", ")}`);
'
}

render_config() {
  run_service_command node "$RENDER_SCRIPT"
  run_service_command node "$FENCE_SCRIPT" "$CONFIG_PATH" "$SOURCE_CONFIG_PATH"
}

ensure_callback_queue() {
  if run_service_command_quiet pnpm exec wrangler queues info "$CALLBACK_QUEUE"; then
    printf 'Queue exists: %s\n' "$CALLBACK_QUEUE"
    return
  fi
  run_service_command pnpm exec wrangler queues create "$CALLBACK_QUEUE" --message-retention-period-secs 345600
}

# Deploy the version, together with INTERNAL_API_SECRET when a source supplies it.
# The JSON secrets file is mode 600, written by node from the environment (never
# an argument) and removed on exit; wrangler applies it additively, so the
# operator-uploaded Access secrets survive.
deploy_with_secrets() {
  if [[ -z "$INTERNAL_SECRET" ]]; then
    run_service_command pnpm exec wrangler deploy --config "$CONFIG_PATH"
    return
  fi
  local secrets_file
  secrets_file=$(mktemp)
  # shellcheck disable=SC2064 # expand the path now
  trap "rm -f '$secrets_file'" EXIT
  chmod 600 "$secrets_file"
  E2E_SECRETS_FILE="$secrets_file" E2E_INTERNAL_SECRET_VALUE="$INTERNAL_SECRET" node -e '
const { writeFileSync } = require("node:fs");
const secrets = { INTERNAL_API_SECRET: process.env.E2E_INTERNAL_SECRET_VALUE };
writeFileSync(process.env.E2E_SECRETS_FILE, JSON.stringify(secrets), { mode: 0o600 });
'
  run_service_command pnpm exec wrangler deploy --config "$CONFIG_PATH" --secrets-file "$secrets_file"
  rm -f "$secrets_file"
  trap - EXIT
}

main() {
  local command="${1:-}"
  case "$command" in
    render | dry-run | deploy) ;;
    *)
      usage >&2
      exit 1
      ;;
  esac

  require_env E2E_FAKE_LLM_HOSTNAME

  case "$command" in
    render)
      render_config
      ;;
    dry-run)
      render_config
      run_service_command pnpm run build:wrapper
      run_service_command pnpm exec wrangler deploy --dry-run --config "$CONFIG_PATH"
      ;;
    deploy)
      prepare_internal_secret
      check_existing_secrets
      render_config
      run_service_command pnpm run build:wrapper
      ensure_callback_queue
      deploy_with_secrets
      if [[ -n "${E2E_WORKER_HOSTNAME:-}" ]]; then
        "$ACCESS_CHECK_SCRIPT" "$E2E_WORKER_HOSTNAME"
      else
        printf 'No E2E_WORKER_HOSTNAME: wrangler leaves a custom domain attached earlier in place; detach it as README.md describes.\n' >&2
      fi
      run_service_command pnpm exec wrangler deployments list --name "$WORKER_NAME"
      ;;
  esac
}

main "$@"
