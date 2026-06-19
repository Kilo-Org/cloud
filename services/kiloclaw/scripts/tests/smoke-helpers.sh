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
  local diagnostic_details

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
if status != "loaded":
    raise SystemExit(f"status={status!r}")
if error:
    raise SystemExit(f"error={error!r}")
print("loaded")
' <<< "$plugin_json" 2>&1); then
    check "kilo-chat plugin inspect" "loaded" "$details"
  else
    check "kilo-chat plugin inspect" "loaded" "failed"
    echo "  details: $details"
    echo "  output: $plugin_json"
  fi

  if diagnostic_details=$(python3 -c '
import json
import sys

known_message = "channel plugin manifest declares kilo-chat without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads. Channels without channelConfigs still appear in channel listings, but setup UI may be limited."
doc = json.load(sys.stdin)
diagnostics = doc.get("diagnostics", [])
if not isinstance(diagnostics, list):
    raise SystemExit("diagnostics is not a list")
known_count = 0
unexpected = []
for diagnostic in diagnostics:
    if not isinstance(diagnostic, dict):
        unexpected.append(repr(diagnostic))
        continue
    if (
        diagnostic.get("level") == "warn"
        and diagnostic.get("pluginId") == "kilo-chat"
        and diagnostic.get("message") == known_message
    ):
        known_count += 1
    else:
        level = diagnostic.get("level", "unknown")
        message = diagnostic.get("message", diagnostic)
        unexpected.append(f"{level}: {message!s}")
if known_count > 1:
    unexpected.append(f"known cosmetic warning repeated {known_count} times")
if unexpected:
    raise SystemExit("; ".join(unexpected))
print("known cosmetic warning" if known_count == 1 else "none")
' <<< "$plugin_json" 2>&1); then
    if [ "$diagnostic_details" = "known cosmetic warning" ]; then
      echo "WARN: kilo-chat plugin diagnostic: missing channelConfigs metadata (known cosmetic warning)"
    fi
    check "kilo-chat plugin diagnostics" "$diagnostic_details" "$diagnostic_details"
  else
    check "kilo-chat plugin diagnostics" "none or known cosmetic warning" "unexpected diagnostic"
    echo "  details: $diagnostic_details"
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

# ── Shared helpers for the app config-write assertions ────────────────────────

# Echoes agents.defaults.model.primary from the live openclaw.json (empty if
# unset). Used to drive behavior-preserving, catalog-independent no-op writes.
_read_config_model_primary() {
  docker exec -i "$1" python3 - <<'PY' 2>/dev/null
import json
from pathlib import Path

doc = json.loads(Path('/root/.openclaw/openclaw.json').read_text())
print(doc.get('agents', {}).get('defaults', {}).get('model', {}).get('primary', ''))
PY
}

# Runs THIS image's own `openclaw config validate` and asserts it still accepts
# the on-disk config. The app config-write routes either skip inline validation
# (/_kilo/config/patch) or write through the OpenClaw CLI, so re-validating after
# each app-shaped write is what catches a newer OpenClaw rejecting our config.
_check_config_validates() {
  local cid="$1"
  local label="$2"
  local result="invalid"
  local output

  if output=$(docker exec "$cid" openclaw config validate --json 2>/dev/null); then
    result=$(python3 -c '
import json
import sys

try:
    doc = json.load(sys.stdin)
except json.JSONDecodeError:
    print("invalid")
    raise SystemExit(0)
print("valid" if doc.get("valid") is True else "invalid")
' <<< "$output")
  fi
  check "$label" "valid" "$result"
}

# Verifies the cloud app's config-write path survives the packaged OpenClaw
# version. The Kilo app (apps/web kiloclaw-internal-client) writes agent/model
# settings by POSTing a deep-merge patch to `/_kilo/config/patch`. That route
# merges and writes openclaw.json and relies on the gateway's file-watch reload —
# it does NOT run `openclaw config validate` inline. So a config shape that a
# newer OpenClaw rejects (e.g. the model-override / agent-selector tightening in
# 2026.6.8) would still return HTTP 200 here and only fail later at reload, which
# the per-version boot asserts cannot catch.
#
# This assertion closes that seam: it replays the documented app patch shape and
# then re-runs THIS image's own validator against the freshly app-written config.
# To stay order-safe and catalog-independent it re-writes `agents.defaults.model
# .primary` to its current value — a behavior-preserving no-op that still drives
# the full deep-merge + atomic-write + validate path.
assert_app_config_patch() {
  local cid="$1"
  local port="$2"
  local token="$3"
  local current
  local body
  local code
  local readback

  echo
  echo "--- app config write (/_kilo/config/patch) ---"

  # Snapshot the configured model primary so the patch is a no-op: a later
  # assertion (and the live turn) still observe the same configured model.
  current=$(_read_config_model_primary "$cid")
  if [ -z "$current" ]; then
    check "app config patch accepted -> 200" "200" "no configured model to patch"
    return
  fi

  # Build the documented app patch shape with a JSON-safe encoder.
  body=$(python3 -c 'import json,sys; print(json.dumps({"agents":{"defaults":{"model":{"primary":sys.argv[1]}}}}))' "$current")

  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data "$body" \
    "http://127.0.0.1:${port}/_kilo/config/patch" 2>/dev/null || true)
  check "app config patch accepted -> 200" "200" "$code"

  # The patch route never validates inline — prove the NEW OpenClaw still accepts
  # the app-written config. This is the assertion the per-version boot lacks.
  _check_config_validates "$cid" "app-written config still validates"

  # Deep-merge integrity: the value we wrote is the value on disk.
  readback=$(_read_config_model_primary "$cid")
  check "app config patch persisted" "$current" "$readback"
}

# Exercises the fleet-wide defaults write the app sends via
# `PATCH /_kilo/config/agent-defaults`. Unlike the deep-merge patch route, this
# goes through the controller's OpenClaw agent-config writer, so it covers a
# distinct serialize/validate path. The model primary is re-set to its current
# value (no-op) to stay order-safe and catalog-independent.
assert_app_config_agent_defaults() {
  local cid="$1"
  local port="$2"
  local token="$3"
  local current
  local body
  local code
  local readback

  echo
  echo "--- app config write (/_kilo/config/agent-defaults) ---"

  current=$(_read_config_model_primary "$cid")
  if [ -z "$current" ]; then
    check "app agent-defaults patch -> 200" "200" "no configured model to patch"
    return
  fi

  # AgentDefaultsPatchBodySchema: { set: { model: { primary } }, unset: [] }.
  body=$(python3 -c 'import json,sys; print(json.dumps({"set":{"model":{"primary":sys.argv[1]}}}))' "$current")

  code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X PATCH \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data "$body" \
    "http://127.0.0.1:${port}/_kilo/config/agent-defaults" 2>/dev/null || true)
  check "app agent-defaults patch -> 200" "200" "$code"

  _check_config_validates "$cid" "config valid after agent-defaults patch"

  readback=$(_read_config_model_primary "$cid")
  check "app agent-defaults persisted" "$current" "$readback"
}

# Exercises the agent CRUD the app drives via `/_kilo/config/agents`, which the
# controller fulfils by shelling out to `openclaw agents add/delete`. This is the
# other half of the surface 2026.6.8 tightened ("rejects unknown OpenAI agent
# selectors"): a model-selector or agent-schema change in a new OpenClaw would
# make `agents add` fail here even though the deep-merge patch path still works.
# Creates a smoke agent (using the configured model selector), reads it back,
# re-validates, then deletes it so the persisted /root carries nothing into the
# next upgrade phase. A pre-delete clears any leftover from a crashed prior run.
assert_app_config_agents_crud() {
  local cid="$1"
  local port="$2"
  local token="$3"
  local name="kc-config-smoke"
  local ws="/root/clawd/kc-config-smoke-ws"
  local model
  local body
  local create_resp
  local create_body
  local create_code
  local agent_id
  local get_code
  local del_code

  echo
  echo "--- app config write (/_kilo/config/agents CRUD) ---"

  model=$(_read_config_model_primary "$cid")

  # Ensure the workspace exists and clear any leftover smoke agent (best effort).
  docker exec "$cid" mkdir -p "$ws" >/dev/null 2>&1 || true
  curl -sS -o /dev/null -X DELETE \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${port}/_kilo/config/agents/${name}" >/dev/null 2>&1 || true

  # BasicAgentCreateBodySchema: { name, workspace(absolute), model? }.
  body=$(python3 -c 'import json,sys
b = {"name": sys.argv[1], "workspace": sys.argv[2]}
if sys.argv[3]:
    b["model"] = sys.argv[3]
print(json.dumps(b))' "$name" "$ws" "$model")

  create_resp=$(curl -sS -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    --data "$body" \
    "http://127.0.0.1:${port}/_kilo/config/agents" 2>/dev/null || true)
  create_code="${create_resp##*$'\n'}"
  create_body="${create_resp%$'\n'*}"
  check "app agent create -> 200" "200" "$create_code"

  # Normalized agent id from the create response (fall back to the raw name).
  agent_id=$(python3 -c '
import json
import sys

try:
    doc = json.loads(sys.stdin.read())
except Exception:
    print("")
    raise SystemExit(0)
created = doc.get("created") or {}
agent = doc.get("agent") or {}
print(created.get("agentId") or agent.get("id") or "")
' <<< "$create_body")
  [ -z "$agent_id" ] && agent_id="$name"

  # The new OpenClaw must still accept the config its own CLI just wrote.
  _check_config_validates "$cid" "config valid after agent create"

  get_code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${port}/_kilo/config/agents/${agent_id}" 2>/dev/null || true)
  check "app agent read-back -> 200" "200" "$get_code"

  # Clean up so the persisted /root carries no smoke agent into the next phase.
  del_code=$(curl -sS -o /dev/null -w "%{http_code}" \
    -X DELETE \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${port}/_kilo/config/agents/${agent_id}" 2>/dev/null || true)
  check "app agent delete -> 200" "200" "$del_code"
}

# Read-only check that the controller's bootstrap seeded exec-approvals.json.
# 2026.6.8 made the exec-approval timeout fail closed, and our bootstrap seeds
# the exec-approval defaults; this confirms that plumbing is intact on the image
# (the file exists with a defaults block and the expected askFallback). No
# mutation, so it is safe to run in any phase order.
assert_exec_approvals_seeded() {
  local cid="$1"
  local details

  echo
  echo "--- exec approvals seeding ---"

  if details=$(docker exec -i "$cid" python3 - <<'PY' 2>&1
import json
from pathlib import Path

path = Path('/root/.openclaw/exec-approvals.json')
if not path.exists():
    raise SystemExit('exec-approvals.json missing')
doc = json.loads(path.read_text())
defaults = doc.get('defaults') if isinstance(doc, dict) else None
if not isinstance(defaults, dict):
    raise SystemExit('no defaults object')
missing = [key for key in ('security', 'ask', 'askFallback') if not defaults.get(key)]
if missing:
    raise SystemExit('missing defaults: ' + ', '.join(missing))
if defaults.get('askFallback') != 'full':
    raise SystemExit(f"askFallback={defaults.get('askFallback')!r} (expected full)")
print('seeded')
PY
  ); then
    check "exec-approvals.json seeded" "seeded" "$details"
  else
    check "exec-approvals.json seeded" "seeded" "failed"
    echo "  details: $details"
  fi
}
