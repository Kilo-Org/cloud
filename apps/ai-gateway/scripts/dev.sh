#!/usr/bin/env bash
set -euo pipefail

# The ai-gateway app serves a slice of the web app's routes, so it runs with the
# web app's environment. PORT is left alone: the dev session exports it for the
# web app.
REPO_ROOT="$(git rev-parse --show-toplevel)"
WEB_DIR="$REPO_ROOT/apps/web"
OFFSET=${KILO_PORT_OFFSET:-0}
AI_GATEWAY_PORT=${AI_GATEWAY_PORT:-$((3010 + OFFSET))}

# Next.js loads .env* files from CWD. Link the files the web app reads: its
# committed .env, plus the local files from apps/web or, failing that, the repo
# root (the same fallback scripts/dev.sh applies for the web app).
link_env_file() {
  local name="$1"
  local source=""
  if [ -e "$WEB_DIR/$name" ]; then
    source="$WEB_DIR/$name"
  elif [ -e "$REPO_ROOT/$name" ]; then
    source="$REPO_ROOT/$name"
  fi
  if [ -n "$source" ] && [ ! -e "$name" ]; then
    ln -s "$source" "$name"
    echo "Symlinked $source → $(pwd)/$name"
  fi
}
for envfile in .env .env.local .env.development.local; do
  link_env_file "$envfile"
done

# Read a value from the linked env files without sourcing them. Exported
# process env beats Next's own .env loading, so each default below only applies
# when neither the shell nor the env files set the variable, as in the web app.
read_env_value() {
  local key="$1"
  local file
  local value

  for file in .env.development.local .env.local; do
    if [ -f "$file" ]; then
      value=$(awk -F= -v key="$key" '
        $1 == key {
          value = substr($0, length(key) + 2)
          gsub(/^["'\'']|["'\'']$/, "", value)
          print value
          exit
        }
      ' "$file")
      if [ -n "$value" ]; then
        echo "$value"
        return
      fi
    fi
  done
}

REDIS_URL="${REDIS_URL:-$(read_env_value REDIS_URL)}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-$(read_env_value UPSTASH_REDIS_REST_URL)}"
export UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
export UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-example_token}"
# Links in responses, such as sign-in and billing URLs, must point at the web
# app rather than at this app.
WEB_PORT=$(cat "$REPO_ROOT/.dev-port" 2>/dev/null || echo $((3000 + OFFSET)))
APP_URL_OVERRIDE="${APP_URL_OVERRIDE:-$(read_env_value APP_URL_OVERRIDE)}"
export APP_URL_OVERRIDE="${APP_URL_OVERRIDE:-http://localhost:$WEB_PORT}"
NEXTAUTH_URL="${NEXTAUTH_URL:-$(read_env_value NEXTAUTH_URL)}"
export NEXTAUTH_URL="${NEXTAUTH_URL:-$APP_URL_OVERRIDE}"

echo "ai-gateway dev server starting on port $AI_GATEWAY_PORT"
exec next dev -H "${NEXT_DEV_HOSTNAME:-0.0.0.0}" -p "$AI_GATEWAY_PORT" "$@"
