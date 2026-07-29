# mobile: Android login.sh fails on loaded host — preflight deep-link reload outlasts flow wait budgets (2026-07-28, r7)

Symptom: every `apps/mobile/e2e/login.sh <serial>` attempt on the Android emulator fails the
settle-app assert ("Welcome to Kilo Code|HOME|..." not visible in 15s) and ends with
"no code email ... the app never reached POST /api/auth/native/otp". Minutes later the app is
settled on the login screen and both adb uiautomator and a fresh `maestro hierarchy` see it fine.

Cause: preflight.sh (~line 106) re-opens the dev-client deep link (`am start ... exp+kilo-app://
expo-development-client/?url=...`) on every login.sh run; on Android that reloads the dev client
to a white splash while the bundle re-initializes. Under parallel-workflow load the reload takes
~1-2 min, far beyond settle-app.yaml (15s) and open-app.yaml (30s) budgets, and the retry path
cold-relaunches (stopApp) so it starts the clock again. Debug hierarchy dumps during the failure
show only the status-bar clock; the Maestro debug screenshot is the white splash.

Fix/workaround: (1) `pm clear com.kilocode.kiloapp` first if the AVD may hold a foreign
worktree's persisted auth (AVDs are machine-global — emulator-5554/kilo_pixel7 carried
e2e-mobile-hermes-mem-c716's session into this worktree); (2) after login.sh fails and the app
has visibly settled (probe with a 20s extendedWaitUntil scratch flow), drive sign-in from scratch
flows (tap 'you@example.com' -> eraseText -> inputText $EMAIL -> pressKey Enter submits via
returnKeyType=go; OTP in dev/logs/emails — ignore the 6-digit PMB in the postal footer; verify
flow handles 'Accept and continue' + notifications prompt). Preflight's effects (claim check,
both adb reverses, Metro provenance) remain from the failed login.sh runs. Android sign-in
itself then works end-to-end (rename-modal pair captured).
