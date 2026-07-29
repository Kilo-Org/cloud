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
# Roles run as windows in the caller's session, or in their own session when
# the caller is not inside tmux.
set -euo pipefail

ROLE=${1:?role} SECTION=${2:?section} LABEL=${3:?label} WT=${4:?worktree} SCRATCH=${5:?scratch} MSG=${6:?message}
shift 6

# Bad input here does not fail fast on its own — it burns a full dispatch and
# an await cycle before anyone notices the round was doomed. Reject it now.
case $ROLE in
  plan-reviewer | implementer | impl-reviewer | e2e-verifier) ;;
  *) echo "dispatch-role: unknown role '$ROLE' (plan-reviewer|implementer|impl-reviewer|e2e-verifier)" >&2; exit 1 ;;
esac
[[ "$SECTION" =~ ^[a-z0-9-]+-[0-9a-f]{4}$ ]] || { echo "dispatch-role: section must be a lowercase slug ending in its 4-hex run id (see init-section.sh): '$SECTION'" >&2; exit 1; }
[[ "$LABEL" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "dispatch-role: bad label '$LABEL'" >&2; exit 1; }
[ -d "$WT" ] || { echo "dispatch-role: no such worktree: $WT" >&2; exit 1; }
[ -f "$WT/.kilo/agent/$ROLE.md" ] || { echo "dispatch-role: $WT has no .kilo/agent/$ROLE.md — the worktree must be the CLOUD worktree (role definitions are only discovered there)" >&2; exit 1; }
[ -d "$SCRATCH" ] || { echo "dispatch-role: no such scratch dir: $SCRATCH" >&2; exit 1; }
# Only `--mode repro` (e2e-verifier repro gate) and repeated `--file
# <existing path>` may follow — anything else (a --model override, a typo)
# silently disagrees with the pinned role definition.
FILES=()
MODE=verify
while [ $# -gt 0 ]; do
  case $1 in
    --mode)
      [ "${2:-}" = "repro" ] || { echo "dispatch-role: --mode takes only 'repro'" >&2; exit 1; }
      [ "$ROLE" = "e2e-verifier" ] || { echo "dispatch-role: --mode repro is only for the e2e-verifier" >&2; exit 1; }
      MODE=repro
      shift 2
      ;;
    --file)
      [ -f "${2:-}" ] || { echo "dispatch-role: --file path does not exist: '${2:-}'" >&2; exit 1; }
      FILE_PATH=$(cd "$(dirname "$2")" && pwd -P)/$(basename "$2")
      FILES+=("--file" "$FILE_PATH")
      shift 2
      ;;
    *) echo "dispatch-role: only --mode repro and --file <path> are accepted after the message, got '$1'" >&2; exit 1 ;;
  esac
done

# The caller supplies a human round label; the script supplies the dispatch id.
# That makes parallel reviewers and same-label retries mechanically distinct,
# so an old .exit file can never vouch for a new run.
TOKEN=$(mktemp "$SCRATCH/.dispatch-XXXXXX")
DISPATCH_ID=${TOKEN##*-}
rm "$TOKEN"
NAME="$SECTION-$ROLE-$LABEL-$DISPATCH_ID"
LOG="$SCRATCH/$ROLE-$LABEL-$DISPATCH_ID.log"
ROLE_SCRATCH=$SCRATCH
if [ "$ROLE" = "e2e-verifier" ]; then
  ROLE_SCRATCH="$SCRATCH/e2e-$LABEL-$DISPATCH_ID"
  mkdir "$ROLE_SCRATCH"
fi
# The strip list must be computed INSIDE the new pane, not here: tmux panes
# inherit the tmux SERVER environment, so vars absent from this dispatcher's
# env can still reach the child and poison a nested kilo run.
# The escaped \$(...) below survives into the pane's shell and evaluates there;
# `|| true` keeps an empty match from failing under the pane's shell.
STRIP='$(env | grep -oE "^(KILO|OPENCODE)[A-Za-z0-9_]*" | sed "s/^/-u /" | tr "\n" " " || true)'

# Redirection below means an attached pane shows nothing at all. Say so in the
# pane itself — a blank window reads as a dead agent otherwise. This prints to
# the terminal only, never into the log, so the EXITCODE contract is untouched.
CMD="echo $(printf '%q' "$NAME: output goes to $LOG — this pane stays blank by design; watch with: tail -f $LOG") && cd $(printf '%q' "$WT") && env $STRIP SCRATCH=$(printf '%q' "$ROLE_SCRATCH") kilo run $(printf '%q' "$MSG") --agent $(printf '%q' "$ROLE") --title $(printf '%q' "$NAME") --auto"
for arg in "${FILES[@]+"${FILES[@]}"}"; do CMD+=" $(printf '%q' "$arg")"; done
# The wrapper-owned exit file is what proves the run ENDED: the in-log
# EXITCODE marker is convenient for humans but shares the stream with agent
# stdout, and an agent quoting "EXITCODE=0" mid-run must not read as done.
CMD+=" > $(printf '%q' "$LOG") 2>&1; EC=\$?; echo \"EXITCODE=\$EC\" >> $(printf '%q' "$LOG"); echo \"\$EC\" > $(printf '%q' "$LOG.exit")"

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

"$(dirname "$0")/launch-gate.sh"

if [ -z "$CALLER_SESSION" ]; then
  tmux new-session -d -s "$NAME" "$CMD"
  TARGET=$NAME
else
  # Trailing colon pins the target to <session>:<auto-index>. Without it tmux
  # prefix-matches the session name against WINDOW names first, and a session
  # named <section> collides with the planner/orchestrator window named
  # <section>-planner — new-window then fails with "create window failed:
  # index N in use".
  # Window indexes are renumbered when an earlier window exits. The stable
  # @<window-id> keeps await/kill aimed at this dispatch for its whole life.
  TARGET=$(tmux new-window -d -P -F '#{window_id}' -t "$CALLER_SESSION:" -n "$NAME" "$CMD")
fi
# Sidecar for await-role.sh: which sentinel contract applies (role + repro
# vs verify for the e2e-verifier) and which tmux target to pronounce dead.
# Same path plus .meta, so dispatchers only ever hand around the log path.
printf 'role=%s\nmode=%s\ntmux=%s\nscratch=%s\n' "$ROLE" "$MODE" "$TARGET" "$ROLE_SCRATCH" > "$LOG.meta"
echo "$LOG"
