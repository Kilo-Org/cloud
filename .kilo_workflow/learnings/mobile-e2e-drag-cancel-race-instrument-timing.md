# mobile: D3 drag-cancel race (7b) — iOS drag NEVER lands mid-settle through the driver; Android adb combined instrument works

Symptom: verifying "drag the list mid-settle cancels the deferred expand" (D3 guard). Tap a
top-clipped thread's expander, then swipe. The thread expands anyway. On iOS this is NOT a
product defect and NOT (as an earlier version of this learning claimed) a drag that "lands
in time".

Cause, measured on-device 2026-07-29 (pr-review-d957 r4, iOS 26.5 sim): the deferred settle
completes in **~316ms** (scrollToIndex animated park + promise resolution). A driver's
tap→swipe turnaround (HTTP round trips between commands) is **~700ms+** on iOS. The drag's `onScrollBeginDrag`
arrives ~400ms AFTER the expansion applied; the "failure" is the product correctly
expanding post-settle and the drag then scrolling the expanded list. r2's iOS 7b "pass" was
the same artifact (the cancel verdict was luck, not mechanism).

Decisive readout (use it again): temporary `console.log` in `invalidateSettle(source)` and
around the scrollToIndex await in `pr-review-discussion-tab.tsx` (byte-restored after) —
Metro captures `[D3R4] begin gen N` / `resolved gen N current M match <bool>` /
`invalidateSettle from drag|retap at <epochMs>`. `match false` = cancel won;
`invalidate` timestamp after `resolved` = instrument too slow.

Working instruments:
1. **Android only**: one `adb shell "input tap x y && input swipe 540 1400 540 1100 250"`
   (~30-50ms gap) on an UNclamped control (top > a11y clamp edge, e.g. y=444 on pixel9
   API35). Confirmed again in r4: drag landed 51ms into the settle, `match false`, thread
   stayed collapsed.
2. iOS: NO sanctioned instrument lands mid-settle (simctl has no touch injection, and the
   per-device wrapper lock prevents a second concurrent session by design). Report iOS 7b as
   instrument-blocked with the trace, and rely on (a) the wiring trace (`invalidateSettle
   from drag` DOES fire for real drags) plus (b) Android 7b for the cancel verdict. Do NOT
   classify an iOS expansion after a driver tap→swipe as a product failure without the trace.
