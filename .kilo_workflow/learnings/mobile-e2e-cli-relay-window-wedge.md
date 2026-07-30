# mobile-e2e-cli-relay-window-wedge

Symptom: the `relay` window of an orchestrator-prepared
`kilo-e2e-cli-<worktree>` tmux session shows an idle shell (`pane_current_command`
= zsh), echoes typed input, but never executes it (no output, no new prompt);
sending C-c then collapses the window.

Cause: the pane's shell was wedged (likely a stopped/zombie job state) after
the original `kilo remote` relay process died; the tmux window only looked
alive in `tmux ls`.

Fix: do not keep probing the wedged pane. Let the window die (or kill it),
recreate it with `tmux new-window -t <cli-session> -n relay`, probe with
`echo OK`, then restart the relay with
`apps/mobile/e2e/remote-cli.sh exec remote` (absolute path) and confirm
`Remote connection enabled.`. The mobile Agents list only discovers the
session while this relay is connected.
