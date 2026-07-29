# mobile: Maestro IOSDriverTimeoutException under multi-simulator load

Symptom: every Maestro command against a claimed iOS simulator fails with `xcuitest.installer.LocalXCTestInstaller$IOSDriverTimeoutException: iOS driver not ready in time`, even with `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000`; `simctl openurl` may also time out (`NSPOSIXErrorDomain code=60`).

Cause: a stale `xcodebuild test-without-building` process left bound to the UDID after a killed Maestro run (check `ps aux | grep xcodebuild` and match the `-xctestrun` temp path / `id=<udid>`), compounded by several same-type simulators booted by sibling worktrees.

Fix: kill only the `xcodebuild` process whose xctestrun path contains your UDID, then `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` (app and login state survive; `login.sh` is idempotent). Validate with a one-step `takeScreenshot` flow before dispatching the verifier again.

Variant — no stale xcodebuild at all (observed 2026-07-28, load avg 45+): the same `IOSDriverTimeoutException` after a killed Maestro run, but `ps aux | grep xcodebuild` is EMPTY — the wedge is the driver itself under load, not a leftover process. Fix: `xcrun simctl shutdown <udid> && xcrun simctl boot <udid>` alone, then validate with a one-step `takeScreenshot` flow and `MAESTRO_DRIVER_STARTUP_TIMEOUT=300000`. Prevention: never let a shell-tool timeout kill `maestro test` mid-wait — size the shell timeout ~3x the flow's worst case under load.
