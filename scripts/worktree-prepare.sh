#!/usr/bin/env bash
set -euo pipefail
# Prepares a git worktree by installing dependencies, linking the Vercel
# project, copying local env files from the main worktree, and syncing the
# web development env from the shared dev env tooling.

MAIN_WORKTREE="$(git worktree list --porcelain | head -1 | sed 's/^worktree //')"
MAIN_WORKTREE_REALPATH="$(cd "$MAIN_WORKTREE" && pwd -P)"
CURRENT_WORKTREE_REALPATH="$(pwd -P)"
ROOT_ENV_FILE=".env.local"
WEB_ENV_FILE="apps/web/.env.development.local"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

if command -v direnv >/dev/null 2>&1 && [ -f .envrc ]; then
  echo "==> Authorizing this worktree's root direnv config…"
  direnv allow .
fi

upsert_env_line() {
  local file="$1"
  local line="$2"
  local key="${line%%=*}"
  local tmp_file="$TMP_DIR/${key}.env"

  if [ -f "$file" ]; then
    awk -v key="$key" 'index($0, key "=") != 1 { print }' "$file" > "$tmp_file"
    cp "$tmp_file" "$file"
  else
    : > "$file"
  fi

  if [ -s "$file" ]; then
    local last_byte
    last_byte="$(tail -c 1 "$file" | od -An -tx1 | tr -d ' \n')"
    if [ "$last_byte" != "0a" ]; then
      printf '\n' >> "$file"
    fi
  fi

  printf '%s\n' "$line" >> "$file"
}

ROOT_ENV_SOURCE=""
ROOT_ENV_SOURCE_LABEL=""
PRE_LINK_ROOT_ENV="$TMP_DIR/pre-link-root.env.local"
POST_LINK_ROOT_ENV="$TMP_DIR/post-link-root.env.local"

if [ -f "$ROOT_ENV_FILE" ]; then
  cp "$ROOT_ENV_FILE" "$PRE_LINK_ROOT_ENV"
  ROOT_ENV_SOURCE="$PRE_LINK_ROOT_ENV"
  ROOT_ENV_SOURCE_LABEL="$ROOT_ENV_FILE before Vercel link"
elif [ "$MAIN_WORKTREE_REALPATH" != "$CURRENT_WORKTREE_REALPATH" ] &&
  [ -f "$MAIN_WORKTREE/$ROOT_ENV_FILE" ]; then
  ROOT_ENV_SOURCE="$MAIN_WORKTREE/$ROOT_ENV_FILE"
  ROOT_ENV_SOURCE_LABEL="main worktree"
fi

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

if [ -f "$ROOT_ENV_FILE" ]; then
  cp "$ROOT_ENV_FILE" "$POST_LINK_ROOT_ENV"
fi

if [ -n "$ROOT_ENV_SOURCE" ]; then
  if [ "$ROOT_ENV_SOURCE" = "$PRE_LINK_ROOT_ENV" ]; then
    echo "==> Restoring $ROOT_ENV_FILE after Vercel link…"
  else
    echo "==> Copying $ROOT_ENV_FILE from ${ROOT_ENV_SOURCE_LABEL}…"
  fi
  cp "$ROOT_ENV_SOURCE" "./$ROOT_ENV_FILE"

  vercel_oidc_token_line="$(grep -m 1 '^VERCEL_OIDC_TOKEN=' "$POST_LINK_ROOT_ENV" 2>/dev/null || true)"
  if [ -n "$vercel_oidc_token_line" ]; then
    upsert_env_line "$ROOT_ENV_FILE" "$vercel_oidc_token_line"
    echo "==> Preserved fresh VERCEL_OIDC_TOKEN in $ROOT_ENV_FILE"
  fi
fi

if [ "$MAIN_WORKTREE_REALPATH" = "$CURRENT_WORKTREE_REALPATH" ]; then
  echo "==> Skipping $WEB_ENV_FILE copy (already in primary worktree)"
elif [ -f "$MAIN_WORKTREE/$WEB_ENV_FILE" ]; then
  echo "==> Copying $WEB_ENV_FILE from main worktree…"
  cp "$MAIN_WORKTREE/$WEB_ENV_FILE" "./$WEB_ENV_FILE"
fi

if [ "$MAIN_WORKTREE_REALPATH" != "$CURRENT_WORKTREE_REALPATH" ] &&
  [ -f "$MAIN_WORKTREE/apps/mobile/.env.local" ]; then
  echo "==> Copying apps/mobile/.env.local from main worktree…"
  cp "$MAIN_WORKTREE/apps/mobile/.env.local" ./apps/mobile/.env.local
fi

if command -v direnv >/dev/null 2>&1 && [ -f apps/mobile/.envrc ]; then
  echo "==> Authorizing this worktree's mobile direnv config…"
  direnv allow ./apps/mobile
fi

echo "==> Syncing Next.js development env…"
pnpm dev:env -y nextjs

echo "==> Worktree ready."
