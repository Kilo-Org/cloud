# mobile: Maestro reports a tap COMPLETED that the iOS keyboard swallowed

Symptom: a flow taps a button, Maestro logs `Tap on "<label>"... COMPLETED`, and nothing happens — the next `assertVisible` times out with Maestro's generic "this could be a real regression" advice, sending the reader after a product bug that does not exist. Typing into the field above the button worked, so the screen looks healthy in the failure screenshot.

Cause: Maestro taps an element's **centre**, and iOS delivers any touch inside `UIRemoteKeyboardWindow` to the keyboard, not to the app. A control that is only partly covered by the keyboard therefore looks tappable and is not: the keyboard window's frame starts a few points above the visible keys, so a centre that clears the keys by a couple of points still lands in it. Maestro cannot see this — it gets no hit-test result back.

Verify it in two commands, both cheap:

```bash
maestro --device <udid> hierarchy        # control centre vs the keyboard window's top bound
grep -E "Tapping [0-9]" ~/.maestro/tests/<run>/<flow>/logs/device-xctest.log
grep -A2 "Sending UIEvent" ~/.maestro/tests/<run>/<flow>/logs/device-simulator.log
```

The simulator log names the receiving window verbatim — `to window: <UIRemoteKeyboardWindow: 0x…>` is proof the app never saw the touch, `<UIWindow…>` (the app's) means look elsewhere.

Because the margin is a handful of points on a centred layout, this is device-model dependent: the same flow passes on a taller simulator and fails on a shorter one, which reads as "it used to work" when the pool hands out a different iPhone.

Fix: keep the control clear of the keyboard in the product (a root `KeyboardAvoidingView` on iOS, not `automaticallyAdjustKeyboardInsets` — that only makes the ScrollView scrollable, it never scrolls, and iOS auto-reveals only the focused field). Do not work around it in the flow with pasteboard tricks or coordinate taps; assert the reachable state instead, and never read a swallowed tap as a product regression.
