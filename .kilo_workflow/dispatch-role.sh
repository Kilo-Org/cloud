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
# Prints the log path. Wait per WORKFLOW.md: the run is done when the tmux
# window/session is gone or `tail -1 <log>` matches ^EXITCODE=[0-9]; then check
# the role's sentinel line — a log without it is a void round.
#
# The e2e-verifier gets its own tmux session (device slots are owned and
# auto-reaped by session name); every other role runs as a window in the
# caller's session.
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

CMD="cd $(printf '%q' "$WT") && env $STRIP kilo run $(printf '%q' "$MSG") --agent $(printf '%q' "$ROLE") --title $(printf '%q' "$NAME")"
for arg in "$@"; do CMD+=" $(printf '%q' "$arg")"; done
CMD+=" > $(printf '%q' "$LOG") 2>&1; echo EXITCODE=\$? >> $(printf '%q' "$LOG")"

if [ "$ROLE" = "e2e-verifier" ]; then
  tmux new-session -d -s "$NAME" "$CMD"
else
  # Trailing colon pins the target to <session>:<auto-index>. Without it tmux
  # prefix-matches the session name against WINDOW names first, and a session
  # named <section> collides with the planner/orchestrator window named
  # <section>-planner — new-window then fails with "create window failed:
  # index N in use" (see learnings/tmux-new-window-index-in-use-name-prefix-collision.md).
  tmux new-window -d -t "$(tmux display-message -p '#S'):" -n "$NAME" "$CMD"
fi
echo "$LOG"
