# mobile-e2e: CLI sessions show "This is a read-only session" in the app until the TUI's own /remote relays them

Symptom: on a session page opened from the Agents list (or deep link), the
composer is absent and the banner "This is a read-only session" shows — for
completed `remote-cli.sh exec run` sessions AND for a session the live TUI
just created, even while `remote-cli.sh exec remote` printed
"Remote connection enabled."

Cause: the app resolves a session writable ('remote') only when it appears in
`activeSessions.list`, which is fed by the OWNING process's relay heartbeat
(`mobile-session-manager.ts` resolveSession → `cliSessionsV2.get` +
`activeSessions.list`). A standalone `exec remote` relay is a separate kilo
process and does not mark sessions held by the TUI (or already-finished
`exec run` sessions) as active. The app also caches the resolved type at
screen-open time, so a session that becomes active later still shows
read-only until re-opened.

Fix: send `/remote` to the RUNNING TUI pane (`tmux send-keys -t
kilo-e2e-cli-<slug>:0 "/remote" Enter`), confirm the `◆ Remote` indicator in
the pane, then re-open the session in the app (deep link again). The composer
mounts and the banner disappears. Composer-bearing E2E cases (typing, slash
menu, swipe-dismiss, growth) require this state; read-only sessions suffice
only for view/long-press/sheet cases.
