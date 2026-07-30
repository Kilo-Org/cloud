# mobile e2e: remote CLI TUI keeps a stale model — send-keys lands in the TUI, relaunch the tmux session with `-m`

Symptom: `apps/mobile/e2e/remote-cli.sh start <email>` launches the kilo TUI with whatever model
the CLI last used (e.g. "MoonshotAI: Kimi K3"), not the E2E-required `kilo/kilo-auto/efficient`.
Trying to fix it by `tmux send-keys "/model kilo/kilo-auto/efficient" Enter` makes it worse: the
keystrokes land **inside the TUI app**, the text is submitted as a user prompt, and a junk
session (titled e.g. "Kilo model configuration review") appears in the account's session list —
the mobile app's Agents tab will show it.

Cause: `remote-cli.sh start` accepts only `<email> [--reinstall]` and launches plain `kilo`; it
has no model flag. A TUI is not a shell — send-keys text goes to the app's input, not to a
command line.

Fix: don't patch the TUI in place. Delete the junk session, kill the tmux session, and relaunch
it pinned:

```bash
apps/mobile/e2e/remote-cli.sh exec session delete <junkSessionID>
tmux kill-session -t kilo-e2e-cli-<worktree-slug>
tmux new-session -d -s kilo-e2e-cli-<worktree-slug> -c "<repo>/dev/.dev-logs/remote-cli/<worktree-slug>" -x 220 -y 50
tmux send-keys -t kilo-e2e-cli-context...:0 "source '<...>/.cli-env' && clear && kilo -m kilo/kilo-auto/efficient" Enter
# then recreate the relay window and confirm:
tmux new-window -t kilo-e2e-cli-<worktree-slug> -n relay
# in it: apps/mobile/e2e/remote-cli.sh exec remote  → "Remote connection enabled."
```

Verify the model in the TUI header (`Auto Efficient Kilo Gateway`) — `exec models` only lists
available models and never shows the current selection.
