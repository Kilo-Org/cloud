# Android dev-client cold start after force-stop: deep link required, rebundle is slow

Symptom: after `adb shell am force-stop com.kilocode.kiloapp`, relaunching with
`am start -n com.kilocode.kiloapp/.MainActivity` lands on the Expo dev-client launcher
("Development Build", server URL list) instead of the app; `monkey -p ... LAUNCHER 1` fails
outright. The app then shows a blank white screen with a single-node, zero-text uiautomator dump
for tens of seconds.

Cause: the dev client needs the metro URL passed via the preflight deep link
(`exp+kilo-app://expo-development-client/?url=<url-encoded http://127.0.0.1:$METRO_PORT>`, see
`apps/mobile/e2e/preflight.sh`). After force-stop the JS bundle is re-fetched and re-built by
metro: 25–65s on emulator on this machine (slower under load with two emulators).

Fix: always relaunch via the deep link (and ensure `adb reverse tcp:$API_PORT` / `tcp:$METRO_PORT`
are set first). A blank white screen + zero-text dump within ~60s of a cold start means LOADING,
not a transparency defect — wait and re-dump before classifying. Contrast with the real iOS
transparency defect: static texts VISIBLE on screen while the interactive subtree is absent from
the a11y tree for 60s+ and only an app relaunch recovers it. Also note Maestro's `settle-app`
assertions in helper flows can time out inside this rebundle window — re-run the flow rather than
classifying the timeout.
