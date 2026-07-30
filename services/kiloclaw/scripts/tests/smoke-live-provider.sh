#!/usr/bin/env bash
set -euo pipefail

# Live packaged-image smoke for KiloClaw + real Kilo Gateway routing.
# This script intentionally uses Auto Free and sends only a generated nonce prompt.
# It is opt-in/manual because it requires live credentials and free-model availability.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-kiloclaw:controller}"
IMAGE_BEFORE="${IMAGE_BEFORE:-$IMAGE}"
IMAGE_AFTER="${IMAGE_AFTER:-$IMAGE}"
# Default to a free ephemeral loopback port so the smoke never collides with a
# running dev stack (e.g. workerd holding the old fixed 18791). Set PORT to pin
# one. The brief bind/close races against `docker run`, but on a random high port
# a collision is far less likely than the previous fixed default.
PORT="${PORT:-$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')}"
TOKEN="${TOKEN:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}"
KILOCODE_CONFIG_PATH="${KILOCODE_CONFIG_PATH:-$HOME/.kilocode/cli/config.json}"
KILOCODE_SMOKE_MODEL="${KILOCODE_SMOKE_MODEL:-kilocode/kilo-auto/free}"
EXPECTED_VERSION_BEFORE="${EXPECTED_VERSION_BEFORE:-}"
EXPECTED_VERSION_AFTER="${EXPECTED_VERSION_AFTER:-}"
MODE="fresh"

source "$SCRIPT_DIR/smoke-helpers.sh"
source "$SCRIPT_DIR/provider-creds.sh"

usage() {
  cat <<'EOF'
Usage: bash scripts/tests/smoke-live-provider.sh [--upgrade]

Runs a packaged KiloClaw image against the real Kilo Gateway using the Auto Free
model by default. Provide KILOCODE_API_KEY explicitly or authenticate with the
Kilo CLI locally so ~/.kilocode/cli/config.json contains an active token.

Options:
  --upgrade  Boot IMAGE_BEFORE, then IMAGE_AFTER on the same temporary /root.

Optional version assertions:
  EXPECTED_VERSION_AFTER   Expected OpenClaw version for the candidate/final image.
  EXPECTED_VERSION_BEFORE  Expected OpenClaw version for --upgrade baseline image.

Optional GitHub gh-auth persistence check (assert_github_gh_auth):
  GITHUB_SMOKE_TOKEN       Disposable GitHub PAT. When set, the smoke boots with
                           GitHub configured and asserts gh auth still works with
                           GITHUB_TOKEN/GH_TOKEN stripped from the exec env
                           (i.e. from the persisted credential store, matching
                           how the agent actually runs). Skipped when unset.
  GITHUB_SMOKE_USERNAME    GitHub username (default: kilo-smoke).
  GITHUB_SMOKE_EMAIL       GitHub email (default: kilo-smoke@example.com).
EOF
}

case "${1:-}" in
  "") ;;
  --upgrade) MODE="upgrade" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

CREDENTIAL_SOURCE="environment"
if [ -z "${KILOCODE_API_KEY:-}" ]; then
  KILOCODE_API_KEY="$(read_active_provider_value kilocodeToken)"
  CREDENTIAL_SOURCE="local Kilo CLI config"
fi
if [ -z "${KILOCODE_API_KEY:-}" ]; then
  echo "Missing KILOCODE_API_KEY and no active kilocodeToken was found in $KILOCODE_CONFIG_PATH." >&2
  echo "Export KILOCODE_API_KEY or authenticate with the Kilo CLI before running this live smoke." >&2
  exit 1
fi

# Fall back to the Kilo CLI config's org id whatever the token's source. This
# used to be gated on CREDENTIAL_SOURCE = "local Kilo CLI config", which meant the
# DOCUMENTED path (export KILOCODE_API_KEY, as the README and the validator both
# instruct) silently skipped org discovery and ran with no org scope at all.
ORG_SOURCE=""
if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
  ORG_SOURCE="environment"
else
  KILOCODE_ORGANIZATION_ID="$(read_active_provider_value kilocodeOrganizationId 2>/dev/null || true)"
  [ -n "${KILOCODE_ORGANIZATION_ID:-}" ] && ORG_SOURCE="local Kilo CLI config"
fi

# Credential preflight. A personal token spends PERSONAL credits; org credits are
# only reachable when the org id travels with the request. Get this wrong and the
# live turn fails deep inside the gateway as a 402, a websocket 1008 policy close,
# or "provider rejected the request schema" — none of which name the real cause,
# and all of which read as a product regression. Fail here instead, by name.
KILOCODE_API_BASE="${KILOCODE_API_BASE:-https://api.kilocode.ai}"
profile_json=$(curl -sL --max-time 20 -H "Authorization: Bearer $KILOCODE_API_KEY" \
  "$KILOCODE_API_BASE/api/profile" 2>/dev/null || true)

if [ -z "$profile_json" ] || ! python3 -c 'import json,sys; json.load(sys.stdin)' <<< "$profile_json" >/dev/null 2>&1; then
  echo "WARN: could not reach $KILOCODE_API_BASE/api/profile to validate the credential." >&2
  echo "      Continuing, but a credential problem will surface later as a confusing" >&2
  echo "      gateway error rather than as a credential error." >&2
elif ! python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("user") else 1)' <<< "$profile_json" >/dev/null 2>&1; then
  echo "✗ The Kilo token was rejected by $KILOCODE_API_BASE/api/profile (not a valid/active key)." >&2
  echo "  Get a key from https://app.kilo.ai/profile (bottom) and export KILOCODE_API_KEY." >&2
  exit 1
else
  org_list=$(python3 -c '
import json
import sys

orgs = json.load(sys.stdin).get("organizations") or []
for o in orgs:
    print(f'"'"'  - {o.get("name", "?")}  {o.get("id", "?")}'"'"')
' <<< "$profile_json" 2>/dev/null || true)

  if [ -z "${KILOCODE_ORGANIZATION_ID:-}" ] && [ -n "$org_list" ]; then
    echo "✗ KILOCODE_ORGANIZATION_ID is not set, but this token belongs to organization(s):" >&2
    echo "$org_list" >&2
    echo >&2
    echo "  A personal token only spends PERSONAL credits. To spend ORG credits the org" >&2
    echo "  id must be set, otherwise the live agent turn fails with '402 Add credits to" >&2
    echo "  continue', which reads as a broken image rather than a credential problem." >&2
    echo >&2
    echo "  Fix (pick the org you want billed):" >&2
    echo "    export KILOCODE_ORGANIZATION_ID=<id from above>" >&2
    echo >&2
    echo "  If this token really does have personal credits and you want to use them," >&2
    echo "  re-run with ALLOW_NO_ORG_SCOPE=true to acknowledge and skip this check." >&2
    if [ "${ALLOW_NO_ORG_SCOPE:-false}" != "true" ]; then
      exit 1
    fi
    echo "  ALLOW_NO_ORG_SCOPE=true set — continuing without org scope." >&2
  fi
fi

export KILOCODE_API_KEY
export KILOCODE_DEFAULT_MODEL="$KILOCODE_SMOKE_MODEL"
if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
  export KILOCODE_ORGANIZATION_ID
fi

for image in "$IMAGE_AFTER"; do
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "Image '$image' is not available locally." >&2
    echo "Build it first from the kiloclaw directory:" >&2
    echo "  docker buildx build --build-context workspace=../.. --load -t $image ." >&2
    exit 1
  fi
done
if [ "$MODE" = "upgrade" ] && ! docker image inspect "$IMAGE_BEFORE" >/dev/null 2>&1; then
  echo "Image '$IMAGE_BEFORE' is not available locally." >&2
  exit 1
fi

ROOTDIR="$(mktemp -d)"
CID=""
PASS=0
FAIL=0

cleanup() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROOTDIR"
}
trap cleanup EXIT

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "PASS: $label (got $actual)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

start_container() {
  local image="$1"
  local -a docker_env=(
    -e OPENCLAW_GATEWAY_TOKEN="$TOKEN"
    -e KILOCODE_API_KEY
    -e KILOCODE_DEFAULT_MODEL
    -e REQUIRE_PROXY_TOKEN=true
  )
  if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
    docker_env+=(-e KILOCODE_ORGANIZATION_ID)
  fi
  # Optional GitHub credential for the gh-auth persistence check (assert_github_gh_auth).
  if [ -n "${GITHUB_SMOKE_TOKEN:-}" ]; then
    docker_env+=(-e GITHUB_TOKEN="$GITHUB_SMOKE_TOKEN")
    docker_env+=(-e GITHUB_USERNAME="${GITHUB_SMOKE_USERNAME:-kilo-smoke}")
    docker_env+=(-e GITHUB_EMAIL="${GITHUB_SMOKE_EMAIL:-kilo-smoke@example.com}")
  fi
  CID=$(docker run -d --rm \
    -p "127.0.0.1:${PORT}:18789" \
    "${docker_env[@]}" \
    -v "$ROOTDIR:/root" \
    "$image")
}

stop_container() {
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 || true
    CID=""
  fi
}

wait_for_ready() {
  local label="$1"
  local response=""
  local state=""

  echo "waiting for $label controller on port $PORT ..."
  for i in $(seq 1 120); do
    response=$(curl -sS "http://127.0.0.1:${PORT}/_kilo/health" 2>/dev/null || true)
    if [[ "$response" == \{* ]]; then
      state=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", ""))' <<< "$response" 2>/dev/null || true)
      case "$state" in
        ready) echo "  ready after ${i}s"; return 0 ;;
        degraded) echo "  DEGRADED: $response"; break ;;
        *) echo "  [$i] state=$state" ;;
      esac
    else
      echo "  [$i] waiting..."
    fi
    sleep 1
  done

  echo "FAIL: $label controller did not reach ready state"
  echo "  Container logs suppressed because startup errors can contain live credentials."
  echo "  Reproduce with disposable credentials before inspecting raw container logs."
  return 1
}

# The controller's /_kilo/health reports `ready` as soon as the controller is up,
# which is NOT the same as the gateway being able to serve a call: the gateway is
# still loading ~32 provider plugins and running model discovery. A call landing
# in that window dies with a websocket 1006 abnormal closure, which looks like a
# product failure but is only a race. Gate on the gateway actually answering a
# lightweight method (`status`) before asserting anything that needs it, and call
# this again after any gateway RESTART, not just after first boot.
wait_for_gateway_serving() {
  local label="$1"

  echo "waiting for $label gateway to serve calls ..."
  for i in $(seq 1 120); do
    if docker exec "$CID" openclaw gateway call status --json --timeout 5000 >/dev/null 2>&1; then
      echo "  gateway serving after ${i}s"
      return 0
    fi
    sleep 1
  done

  echo "FAIL: $label gateway did not start serving calls"
  return 1
}

assert_configured_model() {
  local model
  model=$(docker exec -i "$CID" python3 - <<'PY'
import json
from pathlib import Path

doc = json.loads(Path('/root/.openclaw/openclaw.json').read_text())
print(doc.get('agents', {}).get('defaults', {}).get('model', {}).get('primary', ''))
PY
  )
  check "configured live smoke model" "$KILOCODE_SMOKE_MODEL" "$model"
}

assert_openclaw_version() {
  local expected="$1"
  local output
  local actual

  if [ -z "$expected" ]; then
    return
  fi
  output=$(docker exec "$CID" openclaw --version 2>/dev/null || true)
  actual=$(python3 -c 'import re, sys; match = re.search(r"OpenClaw\s+(\S+)", sys.stdin.read()); print(match.group(1) if match else "")' <<< "$output")
  check "OpenClaw version" "$expected" "$actual"
}

assert_openclaw_config_valid() {
  local output
  local result="invalid"

  if output=$(docker exec "$CID" openclaw config validate --json 2>/dev/null); then
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

  check "OpenClaw config validate" "valid" "$result"
}

assert_gateway_status() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN" \
    "http://127.0.0.1:${PORT}/_kilo/gateway/status")
  check "gateway status (bearer auth) -> 200" "200" "$code"
}

assert_control_ui_proxy() {
  local html
  local result="missing"

  for _ in $(seq 1 30); do
    html=$(curl -sS \
      -H "x-kiloclaw-proxy-token: $TOKEN" \
      "http://127.0.0.1:${PORT}/" 2>/dev/null || true)
    if [[ "$html" == *"<title>OpenClaw Control</title>"* && "$html" == *"<openclaw-app></openclaw-app>"* ]]; then
      result="ready"
      break
    fi
    sleep 1
  done

  check "proxied Control UI HTML" "ready" "$result"
}

# Print the turn's error identity. Only add the "suppressed" caveat when there is
# genuinely nothing more to show: for a transport close we already printed the
# gateway's own close reason, which explains the failure outright.
report_turn_error() {
  local ident="$1"
  if [[ "$ident" == *" :: "* ]]; then
    echo "  error: $ident"
  else
    echo "  error: $ident (provider message suppressed — it can contain live credentials)"
  fi
}

assert_live_agent_turn() {
  local nonce
  local session_id
  local params
  local output
  local parsed

  nonce="KILOCLAW_SMOKE_$(python3 -c 'import secrets; print(secrets.token_hex(8).upper())')"
  session_id="kiloclaw-live-smoke-$(date +%s)"
  params=$(python3 - "$nonce" "$session_id" <<'PY'
import json
import sys

nonce = sys.argv[1]
session_id = sys.argv[2]
print(json.dumps({
    'message': f'Reply with exactly this token and no other text: {nonce}',
    'agentId': 'main',
    'sessionId': session_id,
    'idempotencyKey': session_id,
    'timeout': 180,
}))
PY
  )

  # openclaw writes the --json payload to stdout and logs to stderr; drop stderr
  # (it can contain provider/credential detail) so the parsed value is pure JSON.
  #
  # Retry ONLY the warm-up race: a 1006 abnormal closure, i.e. the gateway
  # vanishing mid-call with no close frame while it is still coming up. Every
  # other outcome is a real result and must fail on the first attempt. That
  # includes other transport closes — notably 1008 (policy violation), which is a
  # DELIBERATE server-side close and reproduces identically on every attempt.
  # Retrying anything broader would mask exactly the incompatibilities this smoke
  # exists to catch.
  local attempt
  local kind=""
  for attempt in 1 2 3; do
    if output=$(docker exec "$CID" openclaw gateway call agent \
      --params "$params" \
      --expect-final \
      --timeout 240000 \
      --json 2>/dev/null); then
      break
    fi

    # Surface the structured error identity, plus the websocket close `reason`
    # for transport errors. That reason is generated by OpenClaw's own gateway
    # (the loopback ws://127.0.0.1:3001 inside the container), not by the model
    # provider, so it carries no credentials and is safe to print — and it is the
    # single most useful line here. Suppressing it hid strings like "pairing
    # required: device is asking for more scopes than currently approved", which
    # names the cause outright. Provider error bodies stay suppressed.
    kind=$(python3 -c '
import json
import sys

try:
    err = json.load(sys.stdin).get("error", {})
except Exception:
    print("unparseable")
    sys.exit()

ident = " ".join(str(err.get(k, "")) for k in ("type", "kind", "code") if err.get(k))
reason = err.get("reason")
if reason and str(err.get("type", "")) == "gateway_transport_error":
    ident = f"{ident} :: {reason}"
print(ident)
' <<< "$output" 2>/dev/null || echo "unparseable")

    if [[ "$kind" != *"gateway_transport_error"*"1006"* ]]; then
      check "live Auto Free agent turn" "nonce returned" "command failed"
      report_turn_error "$kind"
      return
    fi

    echo "  attempt $attempt hit the gateway warm-up race [$kind]; retrying"
    if [ "$attempt" -lt 3 ]; then
      wait_for_gateway_serving "post-transport-error" || true
      sleep 5
    fi
    output=""
  done

  if [ -z "$output" ]; then
    check "live Auto Free agent turn" "nonce returned" "command failed"
    report_turn_error "$kind after 3 attempts"
    return
  fi

  if parsed=$(python3 -c '
import json
import sys

nonce = sys.argv[1]
doc = json.load(sys.stdin)
result = doc.get("result", doc)
payloads = result.get("payloads", []) if isinstance(result, dict) else []
texts = [entry.get("text", "") for entry in payloads if isinstance(entry, dict)]
if not any(nonce in text for text in texts):
    raise SystemExit("response did not contain nonce")
print("nonce returned")
' "$nonce" <<< "$output" 2>&1); then
    check "live Auto Free agent turn" "nonce returned" "$parsed"
  else
    check "live Auto Free agent turn" "nonce returned" "unexpected response"
    echo "  details: $parsed"
    echo "  Gateway output suppressed because provider responses can contain sensitive data."
  fi
}

assert_kilocode_provider_loaded() {
  # Guards Fix 1 (openclaw #93470): the kilocode provider was externalized out of
  # openclaw core into @openclaw/kilocode-provider, installed by the Dockerfile and
  # wired in via plugins.load.paths by config-writer. The keyless image-check only
  # proves the package is installed; this proves it is actually present in the
  # RUNNING config and loaded by the gateway — i.e. model routing won't silently die.
  # Guard the read: if openclaw.json is missing/unreadable/invalid (the very
  # regression this guards), the embedded python exits non-zero. Testing it in an
  # `if` keeps `set -e` from aborting the whole run so it fails cleanly here.
  local path_present
  if ! path_present=$(docker exec -i "$CID" python3 - <<'PY'
import json
from pathlib import Path
doc = json.loads(Path('/root/.openclaw/openclaw.json').read_text())
paths = (((doc.get('plugins') or {}).get('load') or {}).get('paths') or [])
print('yes' if '/usr/local/lib/node_modules/@openclaw/kilocode-provider' in paths else 'no')
PY
  ); then
    path_present="config unreadable"
  fi
  check "kilocode provider on plugins.load.paths" "yes" "$path_present"

  # And confirm the gateway actually loaded it (openclaw writes JSON to stdout,
  # logs to stderr which we drop). Capture the inspect output first so a non-zero
  # exit (e.g. the provider missing — the very case this guards) surfaces as a
  # clean FAIL instead of aborting the whole run under `set -euo pipefail`.
  local raw
  local status
  if ! raw=$(docker exec "$CID" openclaw plugins inspect kilocode --json 2>/dev/null); then
    check "kilocode provider plugin loaded" "loaded" "inspect failed"
    return
  fi
  status=$(python3 -c 'import json,sys
try:
    print((json.load(sys.stdin).get("plugin") or {}).get("status") or "missing")
except Exception:
    print("unparseable")' <<< "$raw")
  check "kilocode provider plugin loaded" "loaded" "$status"
}

assert_kilocode_vision_capability() {
  # Regression guard for the removed model-catalog-refresh workaround (was cloud
  # #4054). That workaround wrote the gateway catalog into
  # models.providers.kilocode.models so the image-capability gate saw vision
  # modalities, because OpenClaw <2026.6.9 could skip runtime discovery for a
  # refreshable catalog (openclaw #93775). openclaw #93786 (in 2026.6.9) fixes
  # that, so on the candidate the kilocode catalog must advertise image input
  # from NATIVE discovery alone. An "available" kilocode model with image input
  # proves discovery repopulated capability metadata without the workaround.
  local output
  local result="pending"

  for _ in $(seq 1 60); do
    output=$(docker exec "$CID" openclaw models list --provider kilocode --all --json 2>/dev/null || true)
    result=$(python3 -c '
import json, sys

# openclaw writes the --json catalog to stdout and logs to stderr (dropped via
# 2>/dev/null above), so stdout is pure JSON. The `docker exec ... || true` above
# can still yield empty/non-JSON output while the catalog is warming up, so treat
# that as a retriable "no-catalog" (exit 0) rather than letting json.load raise
# and abort the whole poll under `set -euo pipefail`.
raw = sys.stdin.read().strip()
if not raw:
    print("no-catalog"); raise SystemExit(0)
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("no-catalog"); raise SystemExit(0)
models = data.get("models", data) if isinstance(data, dict) else data
if not isinstance(models, list):
    print("no-catalog"); raise SystemExit(0)

def is_kilocode(m):
    return str(m.get("key", "")).startswith("kilocode/") or m.get("provider") == "kilocode"

def has_image(m):
    inp = m.get("input")
    if isinstance(inp, str):
        return "image" in inp
    if isinstance(inp, (list, tuple)):
        return "image" in inp
    return False

kc = [m for m in models if isinstance(m, dict) and is_kilocode(m)]
if any(has_image(m) and m.get("available") is True for m in kc):
    print("image-capable")
elif any(has_image(m) for m in kc):
    print("image-capable-unavailable")
elif kc:
    print("text-only")
else:
    print("no-kilocode-models")
' <<< "$output")
    if [ "$result" = "image-capable" ]; then
      break
    fi
    sleep 1
  done

  check "kilocode native vision capability (post-#4054-revert)" "image-capable" "$result"
}

# Verifies the agent can still use GitHub after bootstrap even though OpenClaw
# strips GITHUB_TOKEN/GH_TOKEN from the agent's tool-exec environment
# (host-env-security policy). The controller must persist credentials to gh's
# on-disk store (~/.config/gh/hosts.yml on the /root volume); if it relied only
# on the inherited env var, `gh`/`git` would be unauthenticated in the agent's
# stripped shell — the exact regression that silently broke live instances.
#
# Gated on GITHUB_SMOKE_TOKEN (a disposable PAT + matching username/email) since
# it needs a real GitHub credential to complete `gh auth login`.
assert_github_gh_auth() {
  if [ -z "${GITHUB_SMOKE_TOKEN:-}" ]; then
    echo "SKIP: GitHub gh-auth check (set GITHUB_SMOKE_TOKEN to enable)"
    return 0
  fi

  # 1) Bootstrap must have written gh's credential store to the volume.
  if docker exec "$CID" sh -c '[ -f /root/.config/gh/hosts.yml ]'; then
    check "gh credentials persisted to hosts.yml" "1" "1"
  else
    check "gh credentials persisted to hosts.yml" "1" "0"
  fi

  # 2) The decisive check: gh must authenticate with the token vars stripped
  #    from the environment — reproducing the agent's real exec context. This
  #    fails if the controller never persisted creds (env-conflict regression).
  if docker exec "$CID" env -u GITHUB_TOKEN -u GH_TOKEN gh auth status >/dev/null 2>&1; then
    check "gh auth status ok with token env stripped" "1" "1"
  else
    check "gh auth status ok with token env stripped" "1" "0"
  fi
}

run_phase() {
  local label="$1"
  local image="$2"
  local expected_version="$3"
  # 1 = run the app config-write assertions (they MUTATE openclaw.json). Default 1.
  local mutate_config="${4:-1}"

  echo
  echo "=== $label: $image ==="
  start_container "$image"
  wait_for_ready "$label"
  wait_for_gateway_serving "$label"
  assert_openclaw_version "$expected_version"
  assert_openclaw_config_valid
  assert_gateway_status
  assert_control_ui_proxy
  assert_configured_model
  assert_kilo_chat_smoke "$CID" "$PORT" "$TOKEN"
  # The app config-write routes rewrite openclaw.json. In --upgrade mode they run
  # ONLY on the candidate — after it has booted on the UNTOUCHED baseline-generated
  # root — so the baseline CLI does not rewrite the persisted config first and mask
  # an incompatibility in how the candidate reads the original baseline config.
  if [ "$mutate_config" = "1" ]; then
    assert_app_config_patch "$CID" "$PORT" "$TOKEN"
    assert_app_config_agent_defaults "$CID" "$PORT" "$TOKEN"
    assert_app_config_agents_crud "$CID" "$PORT" "$TOKEN"
    # Candidate only: confirm the externalized kilocode provider is wired into the
    # running config and loaded by the gateway (model routing depends on it).
    assert_kilocode_provider_loaded
    # Candidate only: prove the removed #4054 catalog-refresh workaround is no
    # longer needed — native discovery must supply kilocode image capability.
    assert_kilocode_vision_capability
    # Candidate only, and last of the config mutations: plants a config the
    # gateway cannot start from and proves the restart repairs it instead of
    # crash-looping. Leaves the config valid, so the live turn below still runs
    # against a working gateway — which doubles as proof the repair is sound.
    assert_hook_config_self_heal "$CID" "$PORT" "$TOKEN"
    # That assertion restarts the gateway, and its own wait only gets the
    # CONTROLLER back to ready. Re-gate on the gateway actually serving before
    # the live turn below, or the turn races the gateway's plugin load.
    wait_for_gateway_serving "$label post-self-heal"
  fi
  assert_exec_approvals_seeded "$CID"
  assert_github_gh_auth
  echo
  echo "--- live Auto Free agent turn ---"
  assert_live_agent_turn
  stop_container
}

echo "Credential source: $CREDENTIAL_SOURCE"
echo "Model under test: $KILOCODE_SMOKE_MODEL"
if [ -n "${KILOCODE_ORGANIZATION_ID:-}" ]; then
  echo "Organization scope: configured (from ${ORG_SOURCE:-unknown}) — org credits will be used"
else
  echo "Organization scope: NOT configured — this run spends PERSONAL credits only"
fi

if [ "$MODE" = "upgrade" ]; then
  # Baseline: no config mutations, so its persisted root stays the pristine
  # baseline-generated config the candidate then boots against.
  run_phase "before-image" "$IMAGE_BEFORE" "$EXPECTED_VERSION_BEFORE" 0
  # Candidate: boots on the untouched baseline root, then exercises the config-write
  # routes against the upgraded image.
  run_phase "after-image persisted-root" "$IMAGE_AFTER" "$EXPECTED_VERSION_AFTER" 1
else
  run_phase "candidate-image" "$IMAGE_AFTER" "$EXPECTED_VERSION_AFTER" 1
fi

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
