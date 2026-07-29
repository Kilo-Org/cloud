# mobile: IOSDriverTimeoutException — killing ONLY the stale xcodebuild sufficed (no sim reboot)

Update to `mobile-maestro-ios-driver-timeout-stale-xcodebuild.md` (which prescribes
kill xcodebuild + `simctl shutdown && boot`).

Observed 2026-07-29 (pr-review-d957 repro run, sibling section thrashing Maestro driver restarts
on their own UDID every ~8s): `IOSDriverTimeoutException: iOS driver not ready in time` mid-run.
`ps aux | grep "xcodebuild test-without-building" | grep <UDID>` showed exactly one stale driver
bound to my UDID. Killing just that PID (no simulator shutdown, no reboot) and retrying with
`MAESTRO_DRIVER_STARTUP_TIMEOUT=300000` recovered immediately — app state, scroll position, and
login all survived, so the in-flight E2E probe sequence continued without re-navigation.

Try the kill-only path first; keep the learning's shutdown+boot as the fallback when the driver
still won't come up.
