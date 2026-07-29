# mobile: session-ingest log file stays empty — use dev:capture or tmux pipe-pane for the socket tail

Symptom: `dev/logs/cloudflare-session-ingest.log` is 0 bytes for the whole run, so `tail -f` on it
shows nothing, while the service is clearly logging (connection and heartbeat lines exist).

Cause: this worktree's dev runner writes service output to the tmux pane, not the log file (observed
2026-07-28 on sessions-context-d669; `pnpm dev:capture cloudflare-session-ingest` had all output).

Fix: for one-shot reads use `pnpm dev:capture cloudflare-session-ingest` (runbook-prescribed). For a
continuous capture across a UI interaction (e.g. the context-switch socket-lease check), pipe the
pane: resolve the window with `tmux list-windows -t kilo-dev-<slug>` (cloudflare-session-ingest was
window 12), then `tmux pipe-pane -t kilo-dev-<slug>:12.0 -o "cat >> '<scratch>/ingest-tail.log'"`.
`#{pane_pipe}` = 1 while active. Toggle it off with the same command at cleanup. Record byte offsets
(`wc -c`) at interaction markers to bracket log segments; the wrangler lines carry no timestamps.
