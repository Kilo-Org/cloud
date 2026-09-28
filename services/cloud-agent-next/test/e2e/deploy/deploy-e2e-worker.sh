#!/usr/bin/env bash
set -euo pipefail
set +x

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
CONFIG_PATH=".wrangler/wrangler.e2e-test.jsonc"
RENDER_SCRIPT="test/e2e/deploy/render-e2e-worker-config.mjs"
CALLBACK_QUEUE="cloud-agent-next-callback-queue-e2e-test"
WORKER_NAME="cloud-agent-e2e-test"
INTERNAL_SECRET_VAR="INTERNAL_API_SECRET"
INTERNAL_SECRET=""

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

Commands:
  render    Render .wrangler/wrangler.e2e-test.jsonc from wrangler.jsonc
  dry-run   Render and run wrangler deploy --dry-run
  deploy    Render, ensure the callback queue, deploy, upload the internal secret when one is
            supplied, then list deployments

Required environment:
  FAKE_LLM_BASE_URL  https://<fake-host>/api/openrouter
  E2E_USER_ID        Kilo user id enrolled in CONTROL_PLANE_IDS and
                     WORKTREE_CREATION_ENABLED_IDS. Pass * only as a deliberate
                     opt-in to enrol every authenticated Kilo user.
Optional environment:
  E2E_INTERNAL_API_SECRET Value uploaded as the Worker's INTERNAL_API_SECRET when supplied. Needed
                          for the first deploy or a rotation; omit it on a redeploy to keep the
                          deployed value, which wrangler deploy never clears. The E2E driver always
                          requires it, so export the same value for a run. When unset or empty, the
                          script reads the e2eInternalApiSecret field of E2E_AUTH_FILE instead. Must
                          be at least 16 characters, contain no whitespace, and differ from
                          production's INTERNAL_API_SECRET. The last point is an operator requirement
                          the script cannot prove: it cannot read production's value.
  E2E_AUTH_FILE        Deployed-run JSON file. Its e2eInternalApiSecret field is used when
                       E2E_INTERNAL_API_SECRET is unset or empty.
  WORKER_URL           Defaults to https://cloud-agent-e2e-test.engineering-e11.workers.dev
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
# and upload it after the deploy. Without one, skip the upload: wrangler deploy never
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

# Never print the secret value: the redacted line names the variable instead.
upload_internal_secret() {
  printf '+ printf %%s "[redacted]" | pnpm exec wrangler secret put %s --name %s\n' \
    "$INTERNAL_SECRET_VAR" "$WORKER_NAME" >&2
  (cd "$SERVICE_DIR" && printf '%s' "$INTERNAL_SECRET" | pnpm exec wrangler secret put "$INTERNAL_SECRET_VAR" --name "$WORKER_NAME")
}

render_config() {
  run_service_command node "$RENDER_SCRIPT"
}

ensure_callback_queue() {
  if run_service_command_quiet pnpm exec wrangler queues info "$CALLBACK_QUEUE"; then
    printf 'Queue exists: %s\n' "$CALLBACK_QUEUE"
    return
  fi
  run_service_command pnpm exec wrangler queues create "$CALLBACK_QUEUE" --message-retention-period-secs 345600
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

  require_env FAKE_LLM_BASE_URL

  case "$command" in
    render)
      render_config
      ;;
    dry-run)
      render_config
      run_service_command pnpm exec wrangler deploy --dry-run --config "$CONFIG_PATH"
      ;;
    deploy)
      prepare_internal_secret
      render_config
      ensure_callback_queue
      run_service_command pnpm exec wrangler deploy --config "$CONFIG_PATH"
      if [[ -n "$INTERNAL_SECRET" ]]; then
        upload_internal_secret
      fi
      run_service_command pnpm exec wrangler deployments list --name "$WORKER_NAME"
      ;;
  esac
}

main "$@"
