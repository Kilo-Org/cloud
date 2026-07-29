# mobile: D3 drag-cancel race (7b) — Maestro tap→swipe turnaround loses to the ~300-600ms settle window on Android

Symptom: verifying "drag the list mid-settle cancels the deferred expand" (D3 guard): tap
a top-clipped thread's expander, then swipe. On iOS the drag lands in time and the expand
is cancelled. On Android the thread expands anyway, repeatedly — looks like a platform
defect and is not.

Cause: the deferred expand fires ~300-600ms after the tap (scrollToIndex animation ~300ms
plus promise resolution). Maestro's per-step turnaround (tap command completes, next swipe
command starts) is ~500-800ms on Android, so the drag always begins after the expand.

Fix / instruments, fastest first:
1. One `adb shell` call with both events — `input tap x y && input swipe ...` (~30ms gap) —
   but only with UNclamped control bounds (see
   mobile-android-a11y-bounds-clamped-to-viewport.md); a tap on a clamped sliver misses.
2. `maestro test <tap-only-flow> && adb shell input swipe ...` — still ~500ms, too slow.
3. The same-thread retap (flow 7a) proves generation-cancellation lands mid-settle on
   Android: if a second tap supersedes cleanly (exactly one expand, no collapse), the
   cancel mechanism works on the platform; combine with iOS 7b for the drag path before
   classifying an Android 7b expansion as a product failure.
