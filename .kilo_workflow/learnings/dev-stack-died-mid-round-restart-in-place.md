# Dev stack died mid-round (killed externally or by a stale slot script) — restart in place, don't re-verify from scratch

Symptom: mid-E2E, `pnpm dev:status` suddenly prints "No dev session running", the dev client
loses Metro, and flows start failing on connection errors — with your slot still held and no
crash logs of your own. Usual culprits: another section's stale pre-fix `e2e-slot.sh` copy
stopping the wrong worktree's stack on release, or a slot-covering placeholder session dying and
the reaper stopping the now-uncovered stack.

Cause: the stack was stopped out from under you; nothing about your worktree, data, or device is
wrong. Postgres rows, Durable Object storage, and local D1 files all survive a `dev:stop`.

Fix (verified twice): while the slot is still held, restart the stack in place with the same
port offset and service group from your handoff — `KILO_PORT_OFFSET=<n> pnpm dev:start
--no-attach <services>` (ports are deterministic per worktree, so everything comes back on the
same URLs). Then restore what rode on it: restart the CLI relay if the round uses one
(`apps/mobile/e2e/remote-cli.sh exec remote` → `Remote connection enabled.`), re-anchor the dev
client with the deep link, and re-run only the iteration that was in flight — completed
iterations' device-local measurements stay valid. Classify the interruption as environment
interference, never as a product failure.
