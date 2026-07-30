# mobile e2e Android: UiAutomator2 instrumentation dies at takeScreenshot under parallel-emulator load — ADB screencap fallback

Symptom: mid-flow `WebDriverError: 'GET /screenshot' cannot be proxied to
UiAutomator2 server because the instrumentation process is not running
(probably crashed)`. Seen twice in one round with three emulators + an iOS
simulator running; hierarchy dumps and taps worked minutes before and after.

Cause: the UiAutomator2 instrumentation process is killed/crashes under host
load. The APP is unaffected — screen state, navigation, and the relay survive;
a new appium session (next `appium.sh test`) respawns instrumentation.

Fix: keep time-critical captures on `driver.takeScreenshot()` (tight timing
after a transcript poll), but on a crash do NOT re-drive the flow blind —
inspect with a fresh session, then fall back to
`pnpm dev:mobile:android adb -s <serial> exec-out screencap -p > out.png` for
static states (sheet open, post-dismiss). Same 1080x2424 pixel space as the
uiautomator bounds, so geometry analysis stays valid across both sources.
