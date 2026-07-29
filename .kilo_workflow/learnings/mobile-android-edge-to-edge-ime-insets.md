# mobile/android: on API 35 the app window NEVER resizes for the IME — verify resize claims via dumpsys frames, not layout shifts

Symptom (login-ui-d051 r0/r0b): with `android:windowSoftInputMode="adjustResize"` in the
generated manifest, the Android login screens showed zero layout shift for the email IME
but a uniform 373px shift for the OTP number pad — looking like "the OS resizes for one
IME but not the other".

Cause: on API 35 the window carries `pfl=EDGE_TO_EDGE_ENFORCED` + `fl=LAYOUT_IN_SCREEN
LAYOUT_INSET_DECOR`, so `sim={adjust=resize}` is nominal only — the OS never shrinks the
window for any IME. The IME arrives purely as a `WindowInsets` source. All layout movement
is app-side: RN's `KeyboardAvoidingView behavior="height"` is inert (the ScrollView stays
full-height because the window frame never changes), and the only thing that moves content
is JS consuming `Keyboard` events — on the login screens that is the OTP form's
`bottomSpacer = keyboardHeight + 16` padding, which grew the form view by exactly 746px
(268dp + 16dp) under the number pad and re-centered the `justify-center` container by
spacer/2 = 373px. `keyboardDidShow` DOES fire with a real height on Android for the number
pad (268dp = IME height above the nav bar); a listener that attaches while the keyboard is
already up observes 0 and wrongly concludes the spacer is inert.

How to verify (no code changes):

- `pnpm dev:mobile:android adb -s <serial> shell dumpsys window windows` (the single-subcommand form — full `dumpsys window`
  abbreviates per-window entries and omits `Frames:`/`mFullConfiguration`). Compare the
  app's `winConfig={ mBounds / mAppBounds }` before/after IME: identical rects = no OS resize.
- `dumpsys window | grep "type=ime frame"` gives the authoritative keyboard top/height
  (`InsetsSource id=3 type=ime frame=[0,top][w,h] visible=...`) — better than pixel scans.
- uiautomator container bounds arbitrate the app-side mechanism: full-height ScrollView +
  grown form-view height = JS spacer padding; shrunk ScrollView = KAV height.

Also: on the RN login ScrollView, any `input swipe`/drag blurs the focused field and hides
the IME (`keyboardShouldPersistTaps="handled"` governs taps only) — there is no
swipe-scroll-while-IME-up fallback on Android; and a tap on a keyboard-covered control
lands on the IME window and types into the focused field (app-side no-op, no navigation).
