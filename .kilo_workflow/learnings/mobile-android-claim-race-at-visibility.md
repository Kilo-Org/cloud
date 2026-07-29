# Android emulator claim race on shared adb

Symptom: `pnpm dev:mobile:android claim emulator-5554` refused: "claimed by
/Users/igor/Projects/.worktrees/pr-review-d957" — for an emulator I had just launched myself.

Cause: adb serials are host-global. The runbook order (launch → bounded boot wait → claim →
build) leaves a window between adb visibility and claim; a concurrent worktree's polling loop
claimed my fresh emulator at first visibility (claim record bootId matched my instance's
/proc/sys/kernel/random/boot_id exactly, claimedAt within seconds of first visibility).

Fix: claim AT adb visibility (before waiting for sys.boot_completed). If refused because the
other worktree won the race, do NOT drive the device (never use a device claimed by another
worktree) and do NOT kill it either if your qemu owns it — boot a different AVD/serial instead.
