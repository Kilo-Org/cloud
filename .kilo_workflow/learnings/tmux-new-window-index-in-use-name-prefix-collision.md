# tmux new-window fails "create window failed: index N in use" — session/window name prefix collision

Symptom: `dispatch-role.sh` (or any `tmux new-window -t <session> -n <name> ...`) fails with
`create window failed: index 1 in use` even though the session obviously has free window indexes.
Reproduced on tmux 3.7b: a plain `tmux new-window -d -t <session> -n probe "sleep 5"` fails the
same way while `-t <session>:2` (explicit index) and `-t <session>:` (trailing colon) both work.

Cause: tmux target parsing prefix-matches the target against **window names** before falling back
to the session. The workflow names sessions `<section>` and windows `<section>-<role>` /
`<section>-planner`, so `-t <section>` prefix-matches the planner window (index 1) and tmux tries
to create the new window *at that window's index*, which is taken. Runs whose session name differs
from every window-name prefix (e.g. session `kilo-dev-<section>`) never see it, which is why some
concurrent workflows kept working on the same server.

Fix: target `<session>:` (trailing colon = session with an empty window part → next free index),
which is unambiguous. `dispatch-role.sh` does this; keep the colon. If you hit the symptom
manually, use `-t <session>:` or an explicit free index. Diagnosis recipe: probe with
`tmux new-window -d -t <session> -n probe "sleep 5"`, then compare
`tmux list-windows -t <session> -F '#{window_index} #{window_name}'` for a window whose name
starts with the session name.
