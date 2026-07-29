#!/usr/bin/env bash
# Launch an interactive workflow session (planner, orchestrator, starter) in
# tmux per .kilo_workflow/WORKFLOW.md, encoding the traps so nobody
# hand-assembles them:
#
#   - `--interactive` needs a TTY: the command runs as the tmux window command,
#     never piped or redirected; use --log to attach `tmux pipe-pane` logging.
#   - Full KILO_*/OPENCODE* env strip, computed inside the new pane — the tmux
#     SERVER's environment can poison children even when the caller's is clean
#     — a child kilo inheriting KILO_*/OPENCODE* misattaches sessions and auth.
#   - The caller's session is resolved through $TMUX_PANE. An untargeted
#     `tmux display-message -p '#S'` answers with the server's most recently
#     active session and files the window under an unrelated section. Outside
#     tmux, the launch gets its own session.
#   - The window target carries a trailing colon so tmux cannot prefix-match a
#     window name and fail with "create window failed: index N in use".
#
#   launch-interactive.sh <name> <worktree> --log <file> <command> [args...]
#
#   name      tmux window/session name, e.g. <section>-planner
#   worktree  working directory for the session
#   command   the interactive command and its arguments, as real argv — shell
#             variables like $SCRATCH are expanded by YOUR shell, and no part
#             of it is re-parsed, so backticks in messages stay literal
#
# Prints the tmux target (usable with steer.sh and capture-pane) and verifies
# the pane actually survived startup.
set -euo pipefail

NAME=${1:?name} WT=${2:?worktree}
shift 2
# --log is mandatory: Monitor Mode diagnoses wedges from transcript
# stagnation, and a session without one cannot be told apart from work.
[ "${1:-}" = "--log" ] || { echo "launch-interactive: --log <file> is required (monitors need the transcript)" >&2; exit 1; }
LOGFILE=${2:?log file}
shift 2
[ $# -gt 0 ] || { echo "launch-interactive: no command given" >&2; exit 1; }
[ -d "$WT" ] || { echo "launch-interactive: no such worktree: $WT" >&2; exit 1; }
touch "$LOGFILE" 2>/dev/null || { echo "launch-interactive: cannot write log file $LOGFILE" >&2; exit 1; }

# Machine-global launch spacing: concurrent kilo startups race the shared
# SQLite credential/session stores and crash. Same gate as dispatch-role.sh.
GATE="$HOME/.cache/kilo-launch-gate"
mkdir -p "$GATE"
while :; do
  if mkdir "$GATE/lock" 2>/dev/null; then
    NOW=$(date +%s)
    LAST=$(cat "$GATE/last" 2>/dev/null || echo 0)
    if [ $(( NOW - LAST )) -ge 3 ]; then
      echo "$NOW" > "$GATE/last"
      rmdir "$GATE/lock"
      break
    fi
    rmdir "$GATE/lock"
  fi
  sleep 1
done

STRIP='$(env | grep -oE "^(KILO|OPENCODE)[A-Za-z0-9_]*" | sed "s/^/-u /" | tr "\n" " " || true)'
CMD="env $STRIP"
for arg in "$@"; do CMD+=" $(printf '%q' "$arg")"; done

CALLER_SESSION=""
if [ -n "${TMUX_PANE:-}" ]; then
  CALLER_SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || true)
fi

if [ -n "$CALLER_SESSION" ]; then
  TARGET=$(tmux new-window -d -P -F '#{session_name}:#{window_index}' -t "$CALLER_SESSION:" -n "$NAME" -c "$WT" "$CMD")
else
  tmux new-session -d -s "$NAME" -c "$WT" "$CMD"
  TARGET=$NAME
fi

tmux pipe-pane -t "$TARGET" -o "cat >> $(printf '%q' "$LOGFILE")"

# A command that dies instantly (bad flag, missing binary) closes its pane;
# report that as a failure instead of handing back a dead target. list-panes,
# not display-message — display-message exits 0 for a missing target.
sleep 3
if ! tmux list-panes -t "$TARGET" >/dev/null 2>&1; then
  echo "launch-interactive: $NAME exited immediately — check the command" >&2
  exit 1
fi
echo "$TARGET"
