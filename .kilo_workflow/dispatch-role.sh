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
# `|| true`: with no KILO_*/OPENCODE* vars set (a non-kilo dispatcher), grep
# exits 1 and pipefail would abort the script before the tmux launch.
STRIP=$(env | grep -oE '^(KILO|OPENCODE)[A-Za-z0-9_]*' | sed 's/^/-u /' | tr '\n' ' ' || true)

CMD="cd $(printf '%q' "$WT") && env $STRIP kilo run $(printf '%q' "$MSG") --agent $(printf '%q' "$ROLE") --title $(printf '%q' "$NAME")"
for arg in "$@"; do CMD+=" $(printf '%q' "$arg")"; done
CMD+=" > $(printf '%q' "$LOG") 2>&1; echo EXITCODE=\$? >> $(printf '%q' "$LOG")"

if [ "$ROLE" = "e2e-verifier" ]; then
  tmux new-session -d -s "$NAME" "$CMD"
else
  tmux new-window -d -t "$(tmux display-message -p '#S')" -n "$NAME" "$CMD"
fi
echo "$LOG"
