# mobile: Maestro IOSDriverTimeoutException under multi-simulator load

Symptom: every Maestro command against a claimed iOS simulator fails with `xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready in time`, even with `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000`; `simctl openurl` may also time out (`NSPOSIXErrorDomain code=60`).

Cause: a stale `xcodebuild test-without-building` process left bound to the UDID after a killed Maestro run, compounded by several same-type simulators booted by sibling worktrees.

Fix: stop the round, run `.kilo_workflow/e2e-stop-resource.sh ios`, then free its E2E slot. The simulator wrapper shuts down only a device the worktree claim booted; never kill `xcodebuild` or run `simctl shutdown` by hand. Redispatch fresh, take a slot, and validate through `apps/mobile/e2e/maestro.sh`.

Variant — no stale xcodebuild at all (observed 2026-07-28, load avg 45+): the same `IOSDriverTimeoutException` after a killed Maestro run, but no matching xcodebuild exists — the driver wedged under load. The same release-and-redispatch recovery applies. Size command timeouts above the flow's worst case so the harness does not kill Maestro mid-wait.
