# mobile: headless `remote-cli.sh exec run` sessions never appear in Active now

Symptom: a real CLI turn started with `apps/mobile/e2e/remote-cli.sh exec run ...` writes
`cli_sessions_v2` rows (status busy→idle, live `total_cost_microdollars` and
`last_activity_at` via session-ingest), but the session NEVER shows in the mobile tray —
not while running, not via the relay.

Cause: `/api/sessions/active` (session-ingest heartbeat view) only lists sessions with a live
heartbeat/remote connection. A headless `exec run` process does not register one, and the
separate `exec remote` relay process does not advertise other processes' sessions — so the
router's Phase-1 heartbeat list never contains the run session, and the tray's WS/tRPC paths
never see it. Verified on session-list-ux-19e2: three real `kilo/kilo-auto/efficient` runs
(cost, activity, transcript all persisted; sessions searchable and in history after ending)
with zero tray appearances, while `activeSessions.list` HTTP replays matched exactly.

Fix: choose the probe per acceptance target:
- Cost/activity persistence (items 7/17 server side): probe Postgres directly during the run
  (read-only `docker exec dev-postgres-1 psql`); poll every 8-10s — first live cost advance
  can take ~60-75s into a turn, so run the prompt long enough (>=90s) or you only catch the
  turn-end refresh.
- Tray visibility / activity meta (item 17 client side): seed or drive a row the tray CAN
  see (cloud-agent rows via the DB merge, or a relay/TUI session). Setting
  `last_activity_at=now()` on a live tray row flips its meta to "just now" within one 30s
  poll — a deterministic read-path proof that meta prefers `lastActivityAt`.
- Watch out: `exec run` runs in the WORKTREE ROOT — the model may write files there
  (this round: `sea-poem.txt`). Check `baseline.sh check` before reporting; delete the
  artifact to restore.
