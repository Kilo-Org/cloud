# maestro takeScreenshot output location (iOS, Maestro 2.7.0)

Symptom: `takeScreenshot: <name>` in a flow does NOT write to the process cwd.
Cause: Maestro writes to `~/.maestro/tests/<yyyy-MM-dd_HHmmss>/<flow-name>/takeScreenshot/<name>.png`.
Fix: after the flow, `cp` from that directory; find with
`find ~/.maestro/tests -name "<name>.png" -newer <flow-file>`.
Related: `mobile-maestro-ios-driver-timeout-stale-xcodebuild.md` — never let a
shell-tool timeout kill `maestro test` mid-wait; confirmed again 2026-07-28
(load avg 650+, wedge needed sim shutdown/boot + one driver-check retry).
