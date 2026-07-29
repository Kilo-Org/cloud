# mobile-android-stale-claims-explicit-port

Symptom: `pnpm dev:mobile:android claim emulator-5554` fails with "claimed by
/Users/igor/Projects/.worktrees/<other-worktree>" even though the owning
worktree has no live tmux session and the claiming PID is dead.

Cause: Android claims are per-serial JSON files in
`$TMPDIR/kilo-mobile-android-claims/`. Before 96154f115 ownership was checked
by worktreeRoot equality only, so a claim was never stale while the owning
worktree directory existed, and dead-emulator claims wedged the default
serials (emulator-5554, emulator-5556) permanently. Claims now record the
guest kernel boot id, so a foreign claim self-clears once the emulator that
wrote it no longer answers on the serial — but a *live* foreign emulator on a
default serial still blocks your boot, which lands on the first free serial.

Fix: boot the AVD on an explicit free even console port so the serial is
unclaimed: `pnpm dev:mobile:android emulator -avd <avd> -port 5558
-no-snapshot-save -no-boot-anim -gpu host` → serial `emulator-5558`, then
`claim emulator-5558`. Never delete another worktree's claim file. Record the
port in the round handoff so the next round reuses the same serial.
