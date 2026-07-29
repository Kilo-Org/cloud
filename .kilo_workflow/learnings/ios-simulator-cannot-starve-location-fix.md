# iOS 26.5 simulator: cannot make getCurrentPositionAsync hang (locationd always answers)

Symptom: an E2E flow needs `Location.getCurrentPositionAsync` to never resolve (e.g. to fire an
app-side 10 s GPS-timeout race), but on iOS 26.5 simulators a fix always arrives immediately.

Cause, verified on iPhone 17 Pro / iOS 26.5 (Xcode 26):
- `xcrun simctl location <udid> clear` is non-functional: after `set A` then `clear`, CoreLocation
  keeps serving A; on a freshly erased device it serves a built-in default (observed: Potrero
  District, SF). The clear returns exit 0 and changes nothing.
- `launchctl kill SIGSTOP system/com.apple.locationd` (via `xcrun simctl spawn`) does not produce a
  position-request hang either: a warm app resolves from its in-process CLLocationManager cache
  (Accuracy.Lowest accepts it), and a cold app hangs earlier — inside
  `requestForegroundPermissionsAsync`, before any app-side timeout race starts. The button then
  shows its busy state indefinitely (evidence that the spinner renders while awaiting).
- `killall` does not exist in the sim userland; signal system daemons with
  `xcrun simctl spawn <udid> launchctl kill <SIG> system/<label>` (heeds the
  `user/foreground/<label>` warning; both resolve).

Fix: drive the same outer-catch path with Location Services OFF instead:
`xcrun simctl spawn <udid> defaults write /var/mobile/Library/Preferences/com.apple.locationd.plist
LocationServicesEnabled -bool false`, then restart the daemon
(`launchctl kill SIGTERM system/com.apple.locationd`). Per-app permission stays granted, so
`getCurrentPositionAsync` rejects into the same catch a timeout would. Restore with `-bool true` +
SIGTERM. On-device evidence of the 10 s race itself is not obtainable on a simulator — cover it by
unit test and record the substitution in the report.

Related: Maestro point taps reject decimal percentages (`NumberFormatException: For input string:
"34.4"`) — use absolute coordinates ("201,301") or integer percents.
