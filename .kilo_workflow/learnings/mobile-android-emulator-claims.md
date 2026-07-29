# Android emulator claims: claim at adb visibility, boot on an explicit free port

adb serials are host-global and every worktree shares them, so claims race and collide.
Three rules, each learned from a real incident:

1. **Claim the moment the serial is adb-visible, before waiting for boot.** The old order
   (launch → wait for `sys.boot_completed` → claim) leaves a window in which a concurrent
   worktree's polling loop claims your freshly launched emulator. If you lose that race, do NOT
   drive the device (never use a device claimed by another worktree) and do NOT kill it even if
   your own qemu process owns it — boot a different AVD/serial instead.
2. **Boot on an explicit free even console port so your serial starts unclaimed:**
   `pnpm dev:mobile:android emulator -avd <avd> -port 5558 -no-snapshot-save -no-boot-anim -gpu host`
   → serial `emulator-5558`, then `claim emulator-5558`. A live foreign emulator on a default
   serial (5554/5556) blocks your boot there; claims from dead emulators self-clear (they record
   the guest kernel boot id), but never delete another worktree's claim file yourself. Record
   the port in the round handoff so the next round reuses the same serial.
3. **A fresh worktree may lack `apps/mobile/android/`** even when `doctor` passes — run
   `npx expo prebuild --platform android` in `apps/mobile` before `dev:mobile:android build`
   (the directory is git-ignored codegen). A cached-APK build then installs in seconds.
