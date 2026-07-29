# Android app renders nothing (white) mid-session despite healthy Metro/API

Symptom: dev client loads the bundle ("Running 'main'" in ReactNativeJS) but mounts zero RN
views — screen stays uniform white (native splash never hidden), uiautomator shows only
FrameLayout/ComposeView containers, no errors anywhere. Onset mid-session: Android login UI
rendered fine at 08:56 and 09:18, then every app start (any emulator, fresh VM, -wipe-data,
pm clear, Metro restart, dev-menu Reload, force-stop + deep link) rendered white from ~09:19 on,
while the iOS app kept rendering the same signed-out login branch through the same Metro/API.

Not the cause (all eliminated): AVD disk state (-wipe-data did not help), app data (pm clear),
emulator instance (two AVDs), network (toybox nc to reversed 5300/10381 OK), API health (200s),
Metro process (restarted; serves android bundle 200 10.3MB to host curl).

Suspected: serving-side dev-handshake/bundle state regression on a shared machine with a
concurrent verifier active ("Cannot connect to Expo CLI" seen in ReactNativeJS near a Metro
restart). If it recurs: capture `adb logcat -s ReactNativeJS` for the Expo CLI warning, curl
localhost:<metro>/status, and compare against an iOS control app before burning hours on
emulator-level recoveries — none of them work.
