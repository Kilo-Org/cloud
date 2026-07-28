# mobile: Android emulator bring-up notes (2026-07-28, mobile-ui-ddc7 r7)

- AVD `kilo_pixel7` (sdk_gphone64_arm64) booted in ~2.5 min on attempt 1 with `-gpu host
  -no-snapshot-save -no-boot-anim` under load; `pnpm dev:mobile:android doctor` resolved SDK at
  /opt/homebrew/share/android-commandlinetools and listed 4 kilo_* AVDs.
- `apps/mobile/android/` was missing on this worktree despite the doctor; run
  `npx expo prebuild --platform android` in apps/mobile before `dev:mobile:android build`
  (git-ignored codegen). Cached-APK build then installed in seconds.
- Tab a11y labels match iOS exactly ('Agents, tab, 3 of 4' etc.); the r3 iOS rename-modal flow
  (Greeting row -> 'Rename session: .*' -> tap field -> eraseText -> inputText) ports unchanged.
- adb `exec-out screencap -p` writes fine directly to $SCRATCH (no ~/.maestro/tests hunt).
- Android renders the cleared-field placeholder 'Session name' on the same baseline as typed
  text, vertically centered, unclipped (no iOS-style low placeholder).
