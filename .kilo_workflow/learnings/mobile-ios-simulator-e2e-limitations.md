# mobile: iOS simulator capabilities E2E cannot exercise (keyboard, speech, banners, push)

Symptom: an E2E flow stalls typing into a composer, waits forever for speech recognition, or cannot capture a notification banner — with no product defect involved.

Cause: simulator and environment limits, verified on iPhone 17 / iOS 26.5:

- The software keyboard stays hidden while the simulator's hardware-keyboard setting is on, so automation cannot tap keys. The session-detail composer also resists programmatic focus.
- The speech recognizer never reaches `listening` on a simulator — voice flows cannot be driven end to end.
- Notification banners cannot be screenshot: the simulator lacks notification authorization for pixel-level banner capture.
- Real push delivery (and tap-through) requires `EXPO_ACCESS_TOKEN` in the environment; without it only the deterministic in-app UI and session behaviors are testable.

Fix: disable the hardware keyboard via PlistBuddy on the simulator's preferences plist (then reboot the sim) to restore the software keyboard. For the rest: report those criteria as environment-limited (a skip with rationale), never as product failures, and cover them with unit/integration tests or a manual pass instead.
