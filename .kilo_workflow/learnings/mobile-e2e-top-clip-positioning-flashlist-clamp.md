# mobile: positioning a thread at the top clip — FlashList max-offset clamp and sub-threshold swipes

Symptom: E2E flows that need a collapsed resolved thread clipped ~5-20pt above the visible
content top (PR-review flows 4 / 7a / 7b) cannot nudge the card high enough: swipes stop
moving the list, always at the same card position.

Cause: two independent constraints.
1. The list is at FlashList's computed max scroll offset. The clamp releases only when the
   content BELOW the target card exceeds one viewport height AND has been measured. With
   freshly mounted data (collapsed cards + unmeasured conversation comments), a mid-list
   card simply cannot reach the clip. In the pr-review-d957 fixture (iOS), gamma clamped at
   y228 until page 2 was loaded via "Load more" — r1's own flow-4 setup dump shows page-2
   threads (zeta/eta) already loaded for the same reason. On Android (2424px), zeta could
   not be clipped until theta (below it) was expanded, adding ~850px below.
2. Short swipes (<~10% of screen height, e.g. 1-6%) are silently ignored on both
   platforms (velocity/distance below the scroll-recognition threshold); hierarchy bounds
   stay byte-identical. Do not retry them in a loop — they never land.

Working sequence per platform:
- Load page 2 first (`scrollUntilVisible` 'Load more comments' + tap), or expand a thread
  below the target to grow content.
- Approach with 30% swipes, one gesture at a time with a hierarchy probe between
  (back-to-back gestures after big swipes get ignored intermittently).
- Final 40-100px positioning: iOS — a 6-8% swipe usually lands once the clamp is released;
  Android — `adb shell input swipe x y1 x y2 300` works reliably but ONLY once the offset
  can grow (it is also clamped, not broken).
- Android reminder: the a11y clamp edge (y=444 on pixel9 API35, 1080x2424) is NOT the
  opaque-chrome bottom (~y536 pixels); verify clip geometry with a screenshot pixel scan,
  not bounds alone.
