#!/usr/bin/env bash
# Dispatch a kilo role agent per .kilo_workflow/WORKFLOW.md, encoding the
# contract the learnings exist for: tmux-wrapped (harness timeouts kill bare
# runs), full KILO_*/OPENCODE* env strip, canonical window/log naming, output
# redirected (never piped), and the EXITCODE marker appended as the last line.
#
#   dispatch-role.sh <role> <section> <label> <worktree> <scratch> <message> [--file <path>]...
#
#   role     plan-reviewer | implementer | impl-reviewer | e2e-verifier
#   label    round tag, e.g. r1 or api-r2 (slice-r<round>)
#   message  short literal instruction — file content goes via --file, never $(cat)
#
# Prints the log path. Wait on it with await-role.sh, never a hand-rolled
# loop — it reports DONE with the role's sentinel, VOID, STALLED, or RUNNING.
#
# The e2e-verifier gets its own tmux session (device slots are owned and
# auto-reaped by session name); every other role runs as a window in the
# caller's session, or in its own session when the caller is not inside tmux.
set -euo pipefail

ROLE=${1:?role} SECTION=${2:?section} LABEL=${3:?label} WT=${4:?worktree} SCRATCH=${5:?scratch} MSG=${6:?message}
shift 6

NAME="$SECTION-$ROLE-$LABEL"
LOG="$SCRATCH/$ROLE-$LABEL.log"
# The strip list must be computed INSIDE the new pane, not here: tmux panes
# inherit the tmux SERVER environment, so vars absent from this dispatcher's
# env can still reach the child (see learnings/nested-kilo-run-env-poisoning.md).
# The escaped \$(...) below survives into the pane's shell and evaluates there;
# `|| true` keeps an empty match from failing under the pane's shell.
STRIP='$(env | grep -oE "^(KILO|OPENCODE)[A-Za-z0-9_]*" | sed "s/^/-u /" | tr "\n" " " || true)'

# Redirection below means an attached pane shows nothing at all. Say so in the
# pane itself — a blank window reads as a dead agent otherwise. This prints to
# the terminal only, never into the log, so the EXITCODE contract is untouched.
CMD="echo $(printf '%q' "$NAME: output goes to $LOG — this pane stays blank by design; watch with: tail -f $LOG") && cd $(printf '%q' "$WT") && env $STRIP kilo run $(printf '%q' "$MSG") --agent $(printf '%q' "$ROLE") --title $(printf '%q' "$NAME")"
for arg in "$@"; do CMD+=" $(printf '%q' "$arg")"; done
CMD+=" > $(printf '%q' "$LOG") 2>&1; echo EXITCODE=\$? >> $(printf '%q' "$LOG")"

# Resolve the caller's session through this pane. An untargeted
# `tmux display-message -p '#S'` answers with the SERVER's current session —
# the most recently active one — so a dispatcher running outside tmux (a
# harness shell, a stripped kilo env) silently drops its window into an
# unrelated session. A freshly created `kilo-e2e-android-*` emulator session
# is the usual victim, and it gets killed wholesale on device cleanup.
CALLER_SESSION=""
if [ -n "${TMUX_PANE:-}" ]; then
  CALLER_SESSION=$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null || true)
fi

if [ "$ROLE" = "e2e-verifier" ] || [ -z "$CALLER_SESSION" ]; then
  tmux new-session -d -s "$NAME" "$CMD"
else
  # Trailing colon pins the target to <session>:<auto-index>. Without it tmux
  # prefix-matches the session name against WINDOW names first, and a session
  # named <section> collides with the planner/orchestrator window named
  # <section>-planner — new-window then fails with "create window failed:
  # index N in use" (see learnings/tmux-new-window-index-in-use-name-prefix-collision.md).
  tmux new-window -d -t "$CALLER_SESSION:" -n "$NAME" "$CMD"
fi
echo "$LOG"
