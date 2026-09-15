#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SERVICE_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)
CONFIG_PATH=".wrangler/wrangler.e2e-test.jsonc"
RENDER_SCRIPT="test/e2e/deploy/render-e2e-worker-config.mjs"
CALLBACK_QUEUE="cloud-agent-next-callback-queue-e2e-test"
WORKER_NAME="cloud-agent-e2e-test"

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
  deploy    Render, ensure the callback queue, deploy, then list deployments

Required environment:
  FAKE_LLM_BASE_URL  https://<fake-host>/api/openrouter
Optional environment:
  E2E_USER_ID        Defaults to * (no enrollment restriction)
  WORKER_URL         Defaults to https://cloud-agent-e2e-test.engineering-e11.workers.dev
USAGE
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf '%s is required\n' "$name" >&2
    exit 1
  fi
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
      render_config
      ensure_callback_queue
      run_service_command pnpm exec wrangler deploy --config "$CONFIG_PATH"
      run_service_command pnpm exec wrangler deployments list --name "$WORKER_NAME"
      ;;
  esac
}

main "$@"
