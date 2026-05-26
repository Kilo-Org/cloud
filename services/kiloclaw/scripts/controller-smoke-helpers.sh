#!/usr/bin/env bash

# Shared assertions for KiloClaw controller image smoke scripts.
# Expects the caller to define a `check <label> <expected> <actual>` function.

assert_kilo_chat_config_patched() {
  local cid="$1"
  local details

  if details=$(docker exec -i "$cid" python3 - <<'PY' 2>&1
import json
from pathlib import Path

config_path = Path('/root/.openclaw/openclaw.json')
doc = json.loads(config_path.read_text())
channel = doc.get('channels', {}).get('kilo-chat', {})
plugins = doc.get('plugins', {})
entries = plugins.get('entries', {})
load = plugins.get('load', {})
paths = load.get('paths', [])
expected_path = '/usr/local/lib/node_modules/@kiloclaw/kilo-chat'

checks = [
    ('channels.kilo-chat.enabled', channel.get('enabled') is True),
    ('channels.kilo-chat._configured', channel.get('_configured') is True),
    ('plugins.load.paths includes kilo-chat', expected_path in paths),
    ('plugins.entries.kilo-chat.enabled', entries.get('kilo-chat', {}).get('enabled') is True),
]
failed = [name for name, ok in checks if not ok]
if failed:
    raise SystemExit('missing/invalid: ' + ', '.join(failed))
print('ok')
PY
  ); then
    check "kilo-chat config patched" "ok" "$details"
  else
    check "kilo-chat config patched" "ok" "failed"
    echo "  details: $details"
  fi
}

assert_kilo_chat_plugin_loaded() {
  local cid="$1"
  local plugin_json
  local details

  if ! plugin_json=$(docker exec "$cid" openclaw plugins inspect kilo-chat --json 2>&1); then
    check "kilo-chat plugin inspect" "loaded" "failed"
    echo "  output: $plugin_json"
    return
  fi

  if details=$(python3 -c '
import json
import sys

doc = json.load(sys.stdin)
plugin = doc.get("plugin", {})
status = plugin.get("status")
error = plugin.get("error")
route_count = doc.get("httpRouteCount", 0)
if status != "loaded":
    raise SystemExit(f"status={status!r}")
if error:
    raise SystemExit(f"error={error!r}")
if not isinstance(route_count, int) or route_count < 1:
    raise SystemExit(f"httpRouteCount={route_count!r}")
print("loaded")
' <<< "$plugin_json" 2>&1); then
    check "kilo-chat plugin inspect" "loaded" "$details"
  else
    check "kilo-chat plugin inspect" "loaded" "failed"
    echo "  details: $details"
    echo "  output: $plugin_json"
  fi
}

assert_kilo_chat_webhook_route() {
  local port="$1"
  local token="$2"
  local response
  local body
  local code
  local body_check

  response=$(curl -sS -w "\n%{http_code}" \
    -X POST \
    -H "x-kiloclaw-proxy-token: $token" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data '{"type":"smoke.probe"}' \
    "http://127.0.0.1:${port}/plugins/kilo-chat/webhook" 2>/dev/null || true)
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"

  check "kilo-chat webhook unknown event -> 400" "400" "$code"

  if body_check=$(python3 -c '
import json
import sys

doc = json.loads(sys.stdin.read())
if doc.get("error") != "Unknown webhook type":
    raise SystemExit(doc)
print("Unknown webhook type")
' <<< "$body" 2>&1); then
    check "kilo-chat webhook error body" "Unknown webhook type" "$body_check"
  else
    check "kilo-chat webhook error body" "Unknown webhook type" "failed"
    echo "  details: $body_check"
    echo "  body: $body"
  fi
}

assert_kilo_chat_smoke() {
  local cid="$1"
  local port="$2"
  local token="$3"

  echo
  echo "--- kilo-chat plugin ---"
  assert_kilo_chat_config_patched "$cid"
  assert_kilo_chat_plugin_loaded "$cid"
  assert_kilo_chat_webhook_route "$port" "$token"
}
