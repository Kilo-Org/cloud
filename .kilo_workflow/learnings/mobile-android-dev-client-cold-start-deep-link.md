# Android dev client: cold starts need the deep link, and the reload outlasts flow budgets

Symptom: after wrapped ADB `shell am force-stop com.kilocode.kiloapp`, relaunching with
`am start -n com.kilocode.kiloapp/.MainActivity` lands on the Expo dev-client launcher
("Development Build", server URL list) instead of the app; `monkey -p ... LAUNCHER 1` fails
outright. Separately, `apps/mobile/e2e/login.sh <serial>` fails its settle assert
("Welcome to Kilo Code|HOME|..." not visible in 15s) and never reaches
`POST /api/auth/native/otp` — yet minutes later the app is visibly settled on the login screen.

Cause: the dev client needs the Metro URL passed via the preflight deep link
(`exp+kilo-app://expo-development-client/?url=<url-encoded http://127.0.0.1:$METRO_PORT>`, see
`apps/mobile/e2e/preflight.sh`). After a force-stop — and on every `login.sh` run, because
preflight re-opens the deep link — the JS bundle is re-fetched and rebuilt by Metro: 25–65s on
this machine, and 1–2 minutes under parallel-workflow load, far beyond `settle-app.yaml` (15s)
and `open-app.yaml` (30s) budgets. The retry path cold-relaunches (`stopApp`), restarting the
clock. During the reload the screen is uniform white and uiautomator dumps show only the
status-bar clock.

Fix:

- Always relaunch via the deep link, with the repository wrapper's `adb -s <serial> reverse
  tcp:$API_PORT` / `tcp:$METRO_PORT` set
  first. A blank white screen + zero-text dump within ~60s of a cold start means LOADING, not a
  rendering defect — wait and re-dump before classifying (contrast: the iOS transparency defect
  shows static text on screen while the interactive subtree is missing for 60s+).
- If the AVD may hold a foreign worktree's persisted auth (AVDs are machine-global), run
  `pm clear com.kilocode.kiloapp` first.
- When `login.sh` fails but the app has since settled (probe with a 20s `extendedWaitUntil`
  scratch flow), drive sign-in from scratch flows instead of re-running it: tap
  `you@example.com` → `eraseText` → `inputText $EMAIL` → `pressKey Enter` (submits via
  `returnKeyType=go`); read the OTP from `dev/logs/emails`, ignoring the 6-digit number in the
  postal footer; handle `Accept and continue` and the notifications prompt. Preflight's effects
  (claim check, adb reverses, Metro provenance) survive the failed runs.
