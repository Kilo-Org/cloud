#!/usr/bin/env bash
set -euo pipefail
# Prepares a git worktree by installing dependencies, linking the Vercel
# project, and copying .env.development.local from the main worktree.

MAIN_WORKTREE="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
ENV_FILE="apps/web/.env.development.local"

if command -v nvm &>/dev/null || [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  echo "==> Switching to correct Node version…"
  # nvm is a shell function, not a binary — source it if needed
  if ! command -v nvm &>/dev/null; then
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  fi
  nvm use
fi

echo "==> Installing dependencies…"
pnpm install

echo "==> Linking Vercel project…"
vercel link --yes --project kilocode-app --scope kilocode

if [ "$(cd "$MAIN_WORKTREE" && pwd -P)" = "$(pwd -P)" ]; then
  echo "==> Skipping $ENV_FILE copy (already in primary worktree)"
elif [ -f "$MAIN_WORKTREE/$ENV_FILE" ]; then
  echo "==> Copying $ENV_FILE from main worktree…"
  cp "$MAIN_WORKTREE/$ENV_FILE" "./$ENV_FILE"
fi

echo "==> Worktree ready."
