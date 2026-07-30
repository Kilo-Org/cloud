# mobile: iOS FlashList blanks entirely when maintainVisibleContentPosition is toggled off for one commit and back on (Android tolerates it)

Symptom (pr-review-d957 r5, head df4b6c379): with the deferred-expand path suppressing
`maintainVisibleContentPosition` for exactly the expand commit (`{disabled: true}` for one
auto-batched render, re-enabled on a 150ms timeout), EVERY fired top-clipped deferred
expand on iOS (4/4: gamma, epsilon, zeta geometries, incl. one uninstrumented) leaves the
discussion list COMPLETELY BLANK — no thread rows in the a11y tree, uniform page-colored
viewport, not recoverable by swipes; only a remount (tab switch) brings content back.
`getAbsoluteLastScrollOffset()` at +600ms post-expand reads the deterministic garbage
value `-997949.6666666666` (identical across runs). The settle itself is healthy
(`scrollToIndex resolved … match true` at +330-400ms, offset ~786 — the pre-expand park
lands correctly); the corruption happens at/after the suppressed expand commit or at
re-enable. Android on the same build PASSES all geometries: offset stable post-expand,
header parked at y1300 px on screen (gamma 1248 / epsilon 1314 / zeta 1140 dark px in the
header band, uiautomator title row present).

Consequence for E2E: an iOS blank list after a deferred expand is reproducible 100% and is
NOT the r1-r4 flight signature (header off-screen by expansion height) — it is a distinct,
more severe failure mode. Diagnose with a temporary console.log of
`getLayout(index).y` / `getFirstItemOffset()` / `getAbsoluteLastScrollOffset()` at tap,
settle-resolved, and +600ms post-expand (the D3R5 trace pattern, 7 anchored insertions in
`pr-review-discussion-tab.tsx`); the -997949 offset is the smoking gun. Verify blank vs
flown with a screenshot pixel scan (uniform (251,250,245) below the chrome = blank) plus
the driver hierarchy showing no `Discussion thread` rows.

iOS tap gotcha recorded on the same runs: coordinate taps at y ≤ ~182pt just under the PR
screen's tab chrome are silently swallowed (the driver reports delivery, the handler never runs —
see `ios-tap-swallowed-by-keyboard.md`);
taps at y ≥ 187pt land. Place clipped-thread expand taps at ≥ y190pt.

Fix direction for the product (not applied): do not toggle `disabled` around the commit on
iOS — e.g. gate the suppression to Android, or replace it with the recorded fallback
(exact `scrollToOffset` settle, completion-polled) so mVCP is never cycled.
