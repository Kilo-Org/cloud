import fs from 'node:fs';

const GOG_SHIM_PATH = '/root/go/bin/gog';
const REAL_GOG_PATH = '/usr/local/bin/gog';

const GOG_SHIM_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

REAL_GOG="${REAL_GOG_PATH}"

if [[ "\${KILOCLAW_GOG_SHIM_DISABLE:-}" == "1" ]]; then
  exec "\${REAL_GOG}" "$@"
fi

if [[ -z "\${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
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
  auth_services="$(read_auth_services "$@" || true)"
  if [[ "\${auth_services}" == *calendar* ]] && [[ "\${auth_services}" == *gmail* || "\${auth_services}" == *drive* ]]; then
    echo '[gog-wrapper] mixed legacy+oauth service auth is not supported in one command' >&2
    exit 64
  fi
fi

case "$cmd" in
  calendar|cal)
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
  --data '{"capabilities":["calendar_read"]}' \
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
  fs.mkdirSync('/root/go/bin', { recursive: true });
  fs.writeFileSync(GOG_SHIM_PATH, GOG_SHIM_SCRIPT, { mode: 0o755 });
  fs.chmodSync(GOG_SHIM_PATH, 0o755);
}
