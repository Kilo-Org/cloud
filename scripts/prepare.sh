#!/usr/bin/env bash
set -euo pipefail
# Runs as the npm "prepare" lifecycle hook after pnpm install.
# Skipped entirely in CI — husky hooks and trpc types are unnecessary there
# (CI rebuilds trpc as part of the typecheck script).

if [ -n "${CI:-}" ]; then
  exit 0
fi

husky
pnpm --filter @kilocode/trpc run build
