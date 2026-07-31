# mobile-e2e: assigned Android emulator cleanly shut down between rounds

**Symptom:** slot held, handoff names a live emulator serial/session, but the
device is gone (`adb devices` empty for it; emulator tmux/qemu absent).

**Surfaced by:** `e2e-slot-status.sh` prints
`DEAD device: <serial> claimed by <worktree> (slot held) — owner should relaunch or release`
when a claim/emulator record is tied to a live slot but the device is not in the
booted enumeration. The all-clear footer is suppressed whenever any DEAD line
prints.

**Recovery (agent behavior — not automated):** this is an assigned-resource-not-ready
test-environment blocker. The verifier must **not** relaunch the emulator
(`e2e-start-resource.sh` is the bundle owner's tool). Capture evidence
(`adb devices`, status DEAD line, claim/emulator JSON, emulator log mtime),
return `VERIFICATION BLOCKED.`, and let the bundle owner relaunch via
`.kilo_workflow/e2e-start-resource.sh android <avd>` and redispatch. App +
sign-in usually survive in the AVD data partition, so the next round can start
at `login.sh` verification rather than a full rebuild.
