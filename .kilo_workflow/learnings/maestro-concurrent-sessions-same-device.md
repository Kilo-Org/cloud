# concurrent Maestro sessions against the same device break flows

Symptom: a Maestro flow fails mid-run with element-not-found or a hierarchy that belongs to the
other flow's screen, while a second `maestro test` targets the same device UDID (observed
2026-07-29 on login-ui-d051: a `logout.sh` run failed while another Maestro session against the
same simulator was active; the failure was self-inflicted, not a product defect).

Cause: Maestro's per-device driver (XCUITest on iOS, uiautomator on Android) is single-tenant.
Two concurrent sessions fight over the same accessibility connection; taps and captures
interleave.

Fix: never overlap two `maestro` processes against one device. Before starting a run, check
`ps aux | grep "maestro.*--device"` for the same UDID. If a flow fails inexplicably, first rule
out your own concurrent session before classifying anything as a product defect.
