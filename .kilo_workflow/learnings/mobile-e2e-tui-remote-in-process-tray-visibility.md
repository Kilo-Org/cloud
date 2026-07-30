# mobile-e2e: TUI must enable /remote in-process for tray visibility

Symptom: an interactive kilo TUI session with a busy turn never appears in the
mobile tray or `/api/sessions/active`, even while a separate
`remote-cli.sh exec remote` relay process shows `Remote connection enabled.`
The session persists to Postgres (status/cost/activity all update) but the
heartbeat view lists nothing.

Cause: the heartbeat/active view lists sessions whose OWN process holds a CLI
socket. The separate relay process advertises only its own (empty) session set
— it never advertises the TUI's sessions (same finding as
`mobile-e2e-headless-exec-run-not-tray-visible.md` for headless runs). A stock
TUI posts ingest events over HTTP but opens no CLI socket.

Fix: send `/remote` to the running TUI (one Enter to autocomplete, one to
submit; status line shows `◆ Remote`). The TUI process then registers the CLI
socket for its own session: `/api/sessions/active` lists it within ~12-15s and
the tray row follows on the next poll. Toggling `/remote` off removes it.

Also: `remote-cli.sh start <email>` re-prepares the per-worktree CLI home for a
DIFFERENT account (re-mints the token, kills and recreates the tmux session).
Check which user the prepared token belongs to before driving turns — the CLI
home is per-worktree, not per-platform, so a sibling shard's prep can leave the
TUI authenticated as the other platform's user.
