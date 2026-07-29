#!/usr/bin/env bash
set -euo pipefail
exec "$(dirname "$0")/.e2e-slot-state.sh" release "$@"
