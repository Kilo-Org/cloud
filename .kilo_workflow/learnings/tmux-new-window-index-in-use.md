# tmux new-window fails with "index N in use" on a session with stale index state

Symptom: `tmux new-window -d -t <session> -n <name> <cmd>` fails with
`create window failed: index 1 in use` even though the session plainly has windows 0 and 1 and
index 2 is free. Every role-agent dispatch through `dispatch-role.sh` dies at window creation.

Cause: unknown — the session's automatic index allocation is wedged (observed 2026-07-28 on a
starter-created session minutes old; fresh sessions created the same way allocate fine, and it is
not the active-window index, session options, or hooks). Not worth deeper diagnosis: window index
placement is meaningless to the workflow, which tracks windows by name.

Fix: append instead of auto-allocating — `tmux new-window -da -t <session> -n <name> <cmd>`.
`-a` inserts after the target window and never contends for a specific index. Fixed in
`dispatch-role.sh`; if a hand-rolled `tmux new-window` ever fails this way, add `-a` there too.
Diagnostic for a recurrence: `tmux new-window -d -t <session>:<explicit-free-index>` succeeds,
confirming allocation (not window creation itself) is the broken part.
