import fs from 'node:fs';

const GOG_SHIM_PATH = '/usr/local/bin/gog';
const REAL_GOG_PATH = '/usr/local/bin/gog.real';

const GOG_SHIM_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

REAL_GOG="${REAL_GOG_PATH}"

if [[ "\${KILOCLAW_GOG_SHIM_DISABLE:-}" == "1" ]]; then
  exec "\${REAL_GOG}" "$@"
fi

first_command() {
  local -a args=("$@")
  local i=0
  local count="\${#args[@]}"

  while [[ $i -lt $count ]]; do
    local arg="\${args[$i]}"
    i=$((i + 1))

    case "$arg" in
      --color|--account|--client|--access-token|--enable-commands|--select|-a)
        i=$((i + 1))
        continue
        ;;
      --color=*|--account=*|--client=*|--access-token=*|--enable-commands=*|--select=*)
        continue
        ;;
      --)
        break
        ;;
      -*)
        continue
        ;;
      *)
        printf '%s' "$arg"
        return 0
        ;;
    esac
  done

  return 1
}

cmd="$(first_command "$@" || true)"

has_json_flag() {
  local -a args=("$@")
  local i=0
  local count="\${#args[@]}"
  while [[ $i -lt $count ]]; do
    local arg="\${args[$i]}"
    i=$((i + 1))
    case "$arg" in
      --json|--out=json|--output=json)
        return 0
        ;;
      --out|--output)
        if [[ $i -lt $count ]] && [[ "\${args[$i]}" == "json" ]]; then
          return 0
        fi
        i=$((i + 1))
        ;;
    esac
  done
  return 1
}

auth_subcommand() {
  local -a args=("$@")
  local i=0
  local count="\${#args[@]}"
  local seen_auth=0

  while [[ $i -lt $count ]]; do
    local arg="\${args[$i]}"
    i=$((i + 1))

    if [[ $seen_auth -eq 0 ]]; then
      if [[ "$arg" == "auth" ]]; then
        seen_auth=1
      fi
      continue
    fi

    case "$arg" in
      -*)
        continue
        ;;
      *)
        printf '%s' "$arg"
        return 0
        ;;
    esac
  done

  return 1
}

read_auth_services() {
  local -a args=("$@")
  local i=0
  local count="\${#args[@]}"

  while [[ $i -lt $count ]]; do
    local arg="\${args[$i]}"
    i=$((i + 1))

    case "$arg" in
      --services)
        if [[ $i -lt $count ]]; then
          printf '%s' "\${args[$i]}"
          return 0
        fi
        ;;
      --services=*)
        printf '%s' "\${arg#--services=}"
        return 0
        ;;
    esac
  done

  return 1
}

if [[ "$cmd" == "auth" ]]; then
  subcmd="$(auth_subcommand "$@" || true)"

  if [[ "$subcmd" == "list" ]]; then
    if [[ "\${KILOCLAW_GOOGLE_LEGACY_MIGRATION_FAILED:-}" == "1" ]]; then
      exec "\${REAL_GOG}" "$@"
    fi

    status_tmp="$(mktemp)"
    status_http="$(curl -sS -o "\${status_tmp}" -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer \${OPENCLAW_GATEWAY_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data '{}' \
      "http://127.0.0.1:\${PORT:-18789}/_kilo/google-oauth/status" || true)"

    status_body="$(cat "\${status_tmp}")"
    rm -f "\${status_tmp}"

    if [[ -z "$status_http" ]] || [[ "$status_http" -lt 200 ]] || [[ "$status_http" -ge 300 ]]; then
      error_message="google_oauth_status_failed"
      if command -v jq >/dev/null 2>&1; then
        parsed_error="$(echo "\${status_body}" | jq -r '.error // empty' 2>/dev/null || true)"
        if [[ -n "\${parsed_error}" ]]; then
          error_message="\${parsed_error}"
        fi
      fi
      echo "[gog-wrapper] \${error_message}" >&2
      exit 78
    fi

    if ! command -v jq >/dev/null 2>&1; then
      echo '[gog-wrapper] jq is required for OAuth status parsing' >&2
      exit 78
    fi

    if has_json_flag "$@"; then
      echo "$status_body" | jq -c '{accounts: (.accounts // [])}'
      exit 0
    fi

    account_count="$(echo "$status_body" | jq -r '(.accounts // []) | length')"
    if [[ "$account_count" == "0" ]]; then
      echo "No tokens stored" >&2
      exit 0
    fi

    echo "$status_body" | jq -r '.accounts[] | [
      .email,
      .client,
      ((.services // []) | join(",")),
      (.created_at // ""),
      (.auth // "oauth")
    ] | @tsv'
    exit 0
  fi

  auth_services="$(read_auth_services "$@" || true)"

  if [[ -n "\${auth_services}" ]]; then
    has_google_service=0
    has_non_google_service=0
    IFS=',' read -r -a service_list <<< "\${auth_services}"
    for raw_service in "\${service_list[@]}"; do
      service="\${raw_service//[[:space:]]/}"
      case "\${service}" in
        calendar|gmail|drive|docs|sheets)
          has_google_service=1
          ;;
        *)
          has_non_google_service=1
          ;;
      esac
    done

    if [[ "\${has_google_service}" == "1" ]] && [[ "\${has_non_google_service}" == "1" ]]; then
      echo '[gog-wrapper] mixed google and non-google auth --services is not supported in one command' >&2
      exit 64
    fi
  fi
fi

broker_capabilities=''
case "$cmd" in
  calendar|cal)
    broker_capabilities='["calendar_read"]'
    if [[ "\${KILOCLAW_GOOGLE_LEGACY_MIGRATION_FAILED:-}" == "1" ]]; then
      exec "\${REAL_GOG}" "$@"
    fi
    ;;
  gmail|drive|docs|sheets)
    # OAuth connect currently defaults to calendar-only capabilities.
    # Route non-calendar Google commands to gog.real until broader
    # capability consent is enabled in the web flow.
    exec "\${REAL_GOG}" "$@"
    ;;
  *)
    exec "\${REAL_GOG}" "$@"
    ;;
esac

tmp_file="$(mktemp)"
http_code="$(curl -sS -o "\${tmp_file}" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer \${OPENCLAW_GATEWAY_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "{\\\"capabilities\\\":\${broker_capabilities}}" \
  "http://127.0.0.1:\${PORT:-18789}/_kilo/google-oauth/token" || true)"

response_body="$(cat "\${tmp_file}")"
rm -f "\${tmp_file}"

if [[ -z "\${http_code}" ]] || [[ "\${http_code}" -lt 200 ]] || [[ "\${http_code}" -ge 300 ]]; then
  error_message="google_oauth_token_fetch_failed"
  if command -v jq >/dev/null 2>&1; then
    parsed_error="$(echo "\${response_body}" | jq -r '.error // empty' 2>/dev/null || true)"
    if [[ -n "\${parsed_error}" ]]; then
      error_message="\${parsed_error}"
    fi
  fi
  echo "[gog-wrapper] \${error_message}" >&2
  exit 78
fi

if ! command -v jq >/dev/null 2>&1; then
  echo '[gog-wrapper] jq is required for OAuth token parsing' >&2
  exit 78
fi

access_token="$(echo "\${response_body}" | jq -r '.accessToken // empty')"
account_email="$(echo "\${response_body}" | jq -r '.accountEmail // empty')"

if [[ -z "\${access_token}" ]]; then
  echo '[gog-wrapper] missing access token in broker response' >&2
  exit 78
fi

if [[ -n "\${account_email}" ]]; then
  export GOG_ACCOUNT="\${account_email}"
fi

export GOG_ACCESS_TOKEN="\${access_token}"
exec "\${REAL_GOG}" "$@"
`;

export function installGogShim(): void {
  fs.mkdirSync('/usr/local/bin', { recursive: true });
  fs.writeFileSync(GOG_SHIM_PATH, GOG_SHIM_SCRIPT, { mode: 0o755 });
  fs.chmodSync(GOG_SHIM_PATH, 0o755);
}
