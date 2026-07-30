# mobile/android PR-review E2E: toast a11y-invisibility, deep-link dedupe, disabled-Pressable attribute (pr-review-ux-7f22 r2, 2026-07-30)

Non-machine-specific techniques confirmed on the pixel9 API35 emulator:

1. **sonner-native toasts are NOT in the uiautomator tree at all.** A
   `toast.error('Clipboard is empty')` rendered visually for ~4-8s while 10
   consecutive UiSelector polls (text + content-desc, full-string) returned
   zero matches. Detection must be pixel-based: screenshot ~1.2s after the
   triggering tap, crop the top band (~y17-237 on 1080x2424), diff against a
   baseline frame; auto-dismiss shows up as the band returning to baseline.
   Extends `android-picker-tap-races-and-toast-capture` (which assumed the
   toast is catchable by timing; on this build it is never in the tree).

2. **RN disabled Pressable on Android exports `enabled="false"` but keeps
   `clickable="true"`** (handler artifact). Assert `enabled === 'false'`, and
   for a read-only control also do a functional no-op probe (elementClick,
   then assert state + backend request log unchanged).

3. **Same-route `mobile: deepLink` dedupes**: the router keeps the mounted
   screen, so scroll offset, expansion state, and uncontrolled-field text all
   survive across verifier runs. Scroll-to-top loops must not stop at the
   first a11y sliver of a card (clamped band) — scroll until the needed child
   (e.g. the first hunk gutter line) intersects the card rect. For a truly
   fresh mount: `stopApp` + `launchApp`, then wait for a shell element
   (`Home, tab, 1 of 4`) BEFORE the deep link — a link fired during boot is
   dropped.

4. **CSS `uppercase` transforms the a11y text**: the Resolved badge matches
   `RESOLVED`, not `Resolved`. Check the source for text-transform classes
   before pinning selectors.

5. **DiffLine a11y labels (`Added line 9: ...`) are not exported to
   uiautomator**; the visible per-line signal is the gutter glyph text
   (`+ 9`, `- 8`, `· 15`) plus the merged code text node. Scope glyph/text
   assertions to the card rect (sibling cards render the same strings).

6. **Android uncontrolled-field cleanup**: the entry screen's clear button
   calls `TextInput.clear()`, which on Android unmounts the button (state
   says empty) but leaves the native text. Use driver-level
   `eraseText()` (elementClear) — a real edit that fires onChangeText and
   clears dependent helpers.

7. **adb wedge recovery variant**: guest wedged under host load (3 slots,
   load ~30-60) presented as adbd timeouts -> `adb devices` shows the device
   OFFLINE with qemu at 0% CPU. `adb root` (then `unroot`) restarted adbd and
   the guest came back; bounded polls of `getprop sys.boot_completed`,
   `pidof system_server`, and `pm list packages` confirm health before
   rerunning login.sh. No emulator relaunch needed. Same family as
   `android-emulator-systemserver-restart-systemui-anr-under-load`.
