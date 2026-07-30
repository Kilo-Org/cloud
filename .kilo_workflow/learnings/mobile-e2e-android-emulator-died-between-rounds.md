# mobile-e2e: assigned Android emulator cleanly shut down between rounds; handoff stale

Symptom: a continuation handoff names a live emulator (serial, tmux session, signed-in
account), but at dispatch `adb devices` shows only siblings' devices, the emulator tmux
session (`kilo-e2e-android-<slug>`) is absent, and no qemu process exists for the port.

Diagnosis (observed on session-list-ux-19e2 r3, 2026-07-30): the emulator log
(`$TMPDIR/kilo-e2e-android-<slug>.log`) tail shows a graceful shutdown ("Wait for emulator
(pid N) 20 seconds to shutdown gracefully before kill" then snapshot-save lines) minutes
before dispatch; log mtime marks the death time. The emulator record in
`$TMPDIR/kilo-mobile-android-emulators/<slug>.json` still lists the dead pid, and the
serial claim in `$TMPDIR/kilo-mobile-android-claims/<serial>.json` still says
`status: ready` — neither record reflects liveness. `e2e-slot-status.sh` reports
"no unaccounted known resources" because the slot IS held; it does not probe emulator
liveness.

Verifier action: this is an assigned-resource-not-ready test-environment blocker. Do NOT
relaunch the emulator yourself (`e2e-start-resource.sh android` is the bundle owner's
tool; verifier rule: never start/stop/take bundle resources). Evidence to capture:
`adb devices`, `tmux ls` grep for `kilo-e2e-android-<slug>`, `ps aux | grep qemu`,
tail of the emulator log with its mtime, and the two JSON records. Return
VERIFICATION BLOCKED; the orchestrator relaunches via
`.kilo_workflow/e2e-start-resource.sh android <avd> --gpu host` and redispatches.
App + sign-in survive in the AVD data partition (snapshots were disabled; cold boot only),
so the next round can start at `login.sh` verification, not a rebuild.
