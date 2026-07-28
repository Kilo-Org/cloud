# tmux new-window fails with "index 0 in use" when a window shares the session name

Symptom: `dispatch-role.sh` (or any `tmux new-window -d -t "<session>" -n <name>
<cmd>`) intermittently fails with `create window failed: index 0 in use`, even
though the session has free window indices. Retrying moments later may succeed.

Cause: tmux resolves a bare `-t <name>` target to a *window* named `<name>`
before treating it as a session. When a window in the session is named exactly
like the session — which happens flakily with `automatic-rename on` (the
orchestrator window shows the session name whenever its foreground process
maps to it) — the target becomes that window, and `new-window` tries to create
at the target window's occupied index (0). Whether the bug bites depends on the
window's current auto-renamed name, hence the intermittency.

Fix: target the session unambiguously with a trailing colon:
`tmux new-window -d -t "<session>:" -n <name> <cmd>`. The empty window part
forces session-target parsing and automatic index allocation. Fixed in
`.kilo_workflow/dispatch-role.sh` (2026-07-28).
