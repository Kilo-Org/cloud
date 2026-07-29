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

# Bad input here does not fail fast on its own — it burns a full dispatch and
# an await cycle before anyone notices the round was doomed. Reject it now.
case $ROLE in
  plan-reviewer | implementer | impl-reviewer | e2e-verifier) ;;
  *) echo "dispatch-role: unknown role '$ROLE' (plan-reviewer|implementer|impl-reviewer|e2e-verifier)" >&2; exit 1 ;;
esac
[[ "$SECTION" =~ ^[a-z0-9-]+$ ]] || { echo "dispatch-role: section must be a lowercase slug: '$SECTION'" >&2; exit 1; }
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "dispatch-role: bad label '$LABEL'" >&2; exit 1; }
[ -d "$WT" ] || { echo "dispatch-role: no such worktree: $WT" >&2; exit 1; }
[ -d "$SCRATCH" ] || { echo "dispatch-role: no such scratch dir: $SCRATCH" >&2; exit 1; }
# Only repeated `--file <existing path>` may follow — anything else (a --model
# override, a typo) silently disagrees with the pinned role definition.
FILES=()
while [ $# -gt 0 ]; do
  [ "$1" = "--file" ] || { echo "dispatch-role: only --file <path> is accepted after the message, got '$1'" >&2; exit 1; }
  [ -f "${2:-}" ] || { echo "dispatch-role: --file path does not exist: '${2:-}'" >&2; exit 1; }
  FILES+=("--file" "$2")
  shift 2
done

NAME="$SECTION-$ROLE-$LABEL"
LOG="$SCRATCH/$ROLE-$LABEL.log"
# The strip list must be computed INSIDE the new pane, not here: tmux panes
# inherit the tmux SERVER environment, so vars absent from this dispatcher's
# env can still reach the child and poison a nested kilo run.
# The escaped \$(...) below survives into the pane's shell and evaluates there;
# `|| true` keeps an empty match from failing under the pane's shell.
STRIP='$(env | grep -oE "^(KILO|OPENCODE)[A-Za-z0-9_]*" | sed "s/^/-u /" | tr "\n" " " || true)'

# Redirection below means an attached pane shows nothing at all. Say so in the
# pane itself — a blank window reads as a dead agent otherwise. This prints to
# the terminal only, never into the log, so the EXITCODE contract is untouched.
CMD="echo $(printf '%q' "$NAME: output goes to $LOG — this pane stays blank by design; watch with: tail -f $LOG") && cd $(printf '%q' "$WT") && env $STRIP kilo run $(printf '%q' "$MSG") --agent $(printf '%q' "$ROLE") --title $(printf '%q' "$NAME")"
for arg in "${FILES[@]+"${FILES[@]}"}"; do CMD+=" $(printf '%q' "$arg")"; done
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
  TARGET=$NAME
else
  # Trailing colon pins the target to <session>:<auto-index>. Without it tmux
  # prefix-matches the session name against WINDOW names first, and a session
  # named <section> collides with the planner/orchestrator window named
  # <section>-planner — new-window then fails with "create window failed:
  # index N in use".
  TARGET=$(tmux new-window -d -P -F '#{session_name}:#{window_index}' -t "$CALLER_SESSION:" -n "$NAME" "$CMD")
fi
# Sidecar for await-role.sh: which sentinel contract applies and which tmux
# target to pronounce dead. Same path plus .meta, so dispatchers only ever
# hand around the log path.
printf 'role=%s\ntmux=%s\n' "$ROLE" "$TARGET" > "$LOG.meta"
echo "$LOG"
