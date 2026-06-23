#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tag="${HEADROOM_TAG:-0.27.0-da1a397}"

pnpm exec wrangler containers build -p -t "headroom-compress:${tag}" ./container-build-context
pnpm exec wrangler containers images list --filter headroom-compress --json
