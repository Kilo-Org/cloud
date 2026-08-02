#!/usr/bin/env bash
# Hermetic GitHub API stub for PR-review E2E, as one command pair. `start`
# does the whole ritual that used to be three manual steps: it starts the
# stub server in tmux, points the worktree at it (GITHUB_API_BASE_URL in the
# worktree-root .env.local), and seeds a GitHub token row for the E2E user
# (the PR-review entry screen shows the URL input only when a token row
# exists). `stop` reverses all of it.
#
#   github-stub.sh start <email>   # the account the app is signed in as
#   github-stub.sh seed <email>    # token row for one more signed-in account
#                                  # (e.g. the other platform's verifier),
#                                  # while the stub runs
#   github-stub.sh status
#   github-stub.sh stop
#
# After `start`, relaunch the app so the connection query refetches.
# Fixture identities the stub serves: kilo-stub/discussion-mixed#1,
# kilo-stub/discussion-conversation-only#2, kilo-stub/discussion-empty#3.
#
# If the app stalls on "GitHub connection expired" and nextjs logs repeated
# `githubPrReview.getPullRequest 412`, git-token-service is missing its
# Secrets Store binding:
#   pnpm dev:env -y cloudflare-git-token-service && pnpm dev:restart cloudflare-git-token-service
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
SESSION="kilo-e2e-github-stub-$(basename "$REPO_ROOT")"
STATE_DIR="${TMPDIR:-/tmp}/kilo-e2e-github-stub/$(basename "$REPO_ROOT")"
ENV_LOCAL="$REPO_ROOT/.env.local"
MARKER="# kilo-e2e-github-stub"

nextjs_port() {
  local status
  status="$(cd "$REPO_ROOT" && pnpm -s dev:status --json)"
  node - "$status" <<'NODE'
const status = JSON.parse(process.argv[2]);
const service = status.services.find(s => s.name === 'nextjs');
if (!service || service.status !== 'up' || !service.port) {
  throw new Error('nextjs is not up in this worktree; start the stack first');
}
process.stdout.write(String(service.port));
NODE
}

port_free() { ! nc -z 127.0.0.1 "$1" 2>/dev/null; }

# Machine-global port claims: two worktrees starting stubs at the same moment
# would otherwise pick the same free port, one node would lose the bind, and
# both apps would silently share the winner's mutable fixture state.
PORT_CLAIMS="${TMPDIR:-/tmp}/kilo-e2e-github-stub-ports"
claim_port() { mkdir -p "$PORT_CLAIMS" && mkdir "$PORT_CLAIMS/$1" 2>/dev/null; }
release_port() { [ -z "${STUB_PORT:-}" ] || rmdir "$PORT_CLAIMS/$STUB_PORT" 2>/dev/null || true; }

remove_env_line() {
  # Remove only the line this script added (tagged with the marker).
  [ -f "$ENV_LOCAL" ] || return 0
  grep -v "$MARKER" "$ENV_LOCAL" > "$ENV_LOCAL.tmp.$$" || true
  mv "$ENV_LOCAL.tmp.$$" "$ENV_LOCAL"
}

# Seed a token row for EMAIL through next-auth fake-login. The githubUserId
# must be fresh: github_user_id is unique across the shared postgres, so it
# carries the pid — concurrent seeds in the same second cannot collide.
# SEED_FAIL_MODE=full tears the whole start down; =report only reports.
seed_token() {
  local EMAIL=$1 JAR CSRF CODE GH_USER_ID SEED_BODY
  JAR=$(mktemp "$STATE_DIR/jar.XXXXXX")
  seed_fail() {
    echo "github-stub: token seed failed at $1 for $EMAIL (HTTP ${2:-?})${3:+: $3}" >&2
    echo "github-stub: the user must exist (sign in on the device first, or pnpm dev:seed app:create-user)" >&2
    if [ "$SEED_FAIL_MODE" = full ]; then
      # Undo what start already did, so a failed start leaves nothing behind.
      tmux kill-session -t "=$SESSION" 2>/dev/null || true
      remove_env_line
      rm -rf "$STATE_DIR"
    fi
    exit 1
  }
  CSRF=$(curl -s -c "$JAR" "$BASE/api/auth/csrf" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).csrfToken)') \
    || seed_fail csrf "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/auth/csrf")"
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/callback/fake-login" \
    --data-urlencode "csrfToken=$CSRF" \
    --data-urlencode "email=$EMAIL" \
    --data-urlencode "json=true") || seed_fail fake-login transport
  case $CODE in 2*|3*) ;; *) seed_fail fake-login "$CODE" ;; esac
  GH_USER_ID="9$(date +%s | tail -c 6)$(printf '%05d' $$)$((RANDOM % 90 + 10))"
  SEED_BODY=$(mktemp "$STATE_DIR/seed.XXXXXX")
  CODE=$(curl -s -o "$SEED_BODY" -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/trpc/githubApps.devSeedUserGithubToken" \
    -H 'content-type: application/json' \
    -d "{\"token\":\"e2e-stub-token\",\"githubLogin\":\"kilo-stub-user\",\"githubUserId\":\"$GH_USER_ID\"}") || seed_fail trpc-seed transport
  case $CODE in 2*) ;; *) seed_fail trpc-seed "$CODE" "$(cut -c1-300 "$SEED_BODY")" ;; esac
  grep -q '"error"' "$SEED_BODY" && seed_fail trpc-seed "$CODE" "$(cut -c1-300 "$SEED_BODY")"
  rm -f "$JAR" "$SEED_BODY"
}

case "${1:-}" in
  start)
    EMAIL="${2:?usage: github-stub.sh start <email>}"
    if tmux has-session -t "=$SESSION" 2>/dev/null; then
      echo "github-stub: session $SESSION already runs; stop it first" >&2
      exit 1
    fi
    if [ -f "$ENV_LOCAL" ] && grep -q '^GITHUB_API_BASE_URL=' "$ENV_LOCAL" && ! grep -q "$MARKER" "$ENV_LOCAL"; then
      echo "github-stub: $ENV_LOCAL already sets GITHUB_API_BASE_URL (not ours); refusing to overwrite" >&2
      exit 1
    fi

    API_PORT=$(nextjs_port)
    STUB_PORT=""
    for p in $(seq 4790 4890); do
      if port_free "$p" && claim_port "$p"; then STUB_PORT=$p; break; fi
    done
    [ -n "$STUB_PORT" ] || { echo "github-stub: no free port in 4790-4890" >&2; exit 1; }
    # The claim only has to cover the choose-to-bind window; once our server
    # is bound the port itself blocks other pickers. The trap keeps an
    # interrupted start from leaking the claim.
    trap release_port EXIT

    mkdir -p "$STATE_DIR"
    tmux new-session -d -s "$SESSION" -c "$STATE_DIR" \
      "node $(printf '%q' "$SCRIPT_DIR/github-api-stub/server.mjs") $STUB_PORT"
    for _ in $(seq 1 30); do
      if ! port_free "$STUB_PORT"; then break; fi
      sleep 0.5
    done
    # A bound port alone does not prove OUR server owns it — if our node lost
    # the bind and died, the session is gone and the listener is a stranger.
    if port_free "$STUB_PORT" || ! tmux has-session -t "=$SESSION" 2>/dev/null; then
      echo "github-stub: server did not come up on port $STUB_PORT" >&2
      tmux kill-session -t "=$SESSION" 2>/dev/null || true
      exit 1
    fi
    release_port

    remove_env_line
    # A .env.local without a trailing newline would merge our append into its
    # last line — and stop's marker removal would then delete that variable.
    if [ -s "$ENV_LOCAL" ] && [ "$(tail -c1 "$ENV_LOCAL")" != "" ]; then
      printf '\n' >> "$ENV_LOCAL"
    fi
    printf 'GITHUB_API_BASE_URL=http://127.0.0.1:%s %s\n' "$STUB_PORT" "$MARKER" >> "$ENV_LOCAL"

    BASE="http://127.0.0.1:$API_PORT"
    SEED_FAIL_MODE=full
    seed_token "$EMAIL"

    printf 'port=%s\n' "$STUB_PORT" > "$STATE_DIR/state"
    echo "github-stub: up at http://127.0.0.1:$STUB_PORT (tmux $SESSION), token seeded for $EMAIL"
    echo "github-stub: relaunch the app now so the connection query refetches"
    ;;

  seed)
    EMAIL="${2:?usage: github-stub.sh seed <email>}"
    tmux has-session -t "=$SESSION" 2>/dev/null || {
      echo "github-stub: no running stub — use start for the first account" >&2
      exit 1
    }
    BASE="http://127.0.0.1:$(nextjs_port)"
    SEED_FAIL_MODE=report
    seed_token "$EMAIL"
    echo "github-stub: token seeded for $EMAIL (stub untouched)"
    ;;

  status)
    if tmux has-session -t "=$SESSION" 2>/dev/null; then
      echo "up (tmux $SESSION, $(sed -n 's/^port=/port /p' "$STATE_DIR/state" 2>/dev/null))"
    else
      echo "down"
      exit 1
    fi
    ;;

  stop)
    tmux kill-session -t "=$SESSION" 2>/dev/null && echo "github-stub: stopped $SESSION" || echo "github-stub: no session to stop"
    remove_env_line
    rm -rf "$STATE_DIR"
    echo "github-stub: removed env line and state"
    ;;

  *) echo "usage: github-stub.sh start <email> | seed <email> | status | stop" >&2; exit 1 ;;
esac
