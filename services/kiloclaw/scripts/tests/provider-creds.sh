#!/usr/bin/env bash

# Shared Kilo CLI credential lookup, sourced by the live smoke (smoke-live-provider.sh)
# and the upgrade orchestrator's preflight (openclaw-upgrade-validate.sh) so both
# decide "is a credential available?" the same way.
#
# It reads a field from the ACTIVE provider in the Kilo CLI config — the provider
# named by the top-level "provider" id — and echoes its value only when non-empty.
# A stale entry or a token on an inactive provider therefore does NOT count as an
# available credential (which is what the live smoke actually requires).
#
# Honors KILOCODE_CONFIG_PATH (default ~/.kilocode/cli/config.json).

KILOCODE_CONFIG_PATH="${KILOCODE_CONFIG_PATH:-$HOME/.kilocode/cli/config.json}"

read_active_provider_value() {
  local field="$1"
  python3 - "$KILOCODE_CONFIG_PATH" "$field" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1]).expanduser()
field = sys.argv[2]
try:
    document = json.loads(path.read_text())
except FileNotFoundError:
    raise SystemExit(0)
except (OSError, json.JSONDecodeError) as error:
    print(f'Unable to read Kilo CLI config at {path}: {error}', file=sys.stderr)
    raise SystemExit(1)

active_id = document.get('provider')
providers = document.get('providers', [])
if not isinstance(active_id, str) or not isinstance(providers, list):
    raise SystemExit(0)

for provider in providers:
    if not isinstance(provider, dict) or provider.get('id') != active_id:
        continue
    value = provider.get(field)
    if isinstance(value, str) and value:
        sys.stdout.write(value)
    raise SystemExit(0)
PY
}
