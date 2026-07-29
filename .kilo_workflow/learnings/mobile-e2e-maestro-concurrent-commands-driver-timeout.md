# mobile: never run two maestro commands concurrently on one UDID; screenshot loops finish before maestro's slow startup

Symptom: `IOSDriverTimeoutException: iOS driver not ready in time` mid-run on iOS when a
background `maestro test` (tap) overlapped a `maestro hierarchy` started 1.5s later on the
same simulator. Two XCUITest channels on one UDID wedge the driver.

Recovery: kill only the stale `xcodebuild test-without-building` PID bound to the UDID
(see `mobile-maestro-ios-driver-timeout-kill-stale-only.md`); app state, scroll position,
and login all survive. Retry with `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000`.

Second, related timing fact (iOS, machine under parallel-workflow load): maestro's JVM +
driver startup takes 15-25+s before the tap lands. A `xcrun simctl io screenshot` loop
(10-30 shots, ~0.5s each) started concurrently with the tap command ALWAYS finishes before
the tap lands — every frame is pre-tap. Timed screenshot/hierarchy capture of sub-second
windows (e.g. an 800ms probe delay) is not achievable this way, and concurrent maestro
for the window is what causes the timeout above.

What works instead: instrument the app with temporary `console.log` probes (captured from
`pnpm dev:capture mobile`), take hierarchy dumps at leisure before and after the
interaction, and DERIVE mid-window screen geometry from the logged scroll values:
screen_y = (layoutY + firstItemOffset) - absoluteLastScrollOffset + K, where K (the
screen-y of the list viewport's content-top edge) is calibrated from a moment where both a
hierarchy bound and the logged offsets are known. On pr-review-d957 iOS K=367, confirmed
within ±1.3pt at five independent moments across three runs and scroll regions.
