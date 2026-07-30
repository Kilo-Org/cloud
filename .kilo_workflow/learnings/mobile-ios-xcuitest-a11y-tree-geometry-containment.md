# mobile iOS: XCUI tree — a11y-labeled parent Views are leaves; assert by geometry, not XML ancestry

Symptom: a flow parses `driver.getPageSource()` to assert "snippet inside thread card" via XML
parent/child containment and finds the card node has ZERO descendants — while pills, snippets and
comment texts all render on screen. Plain-text labels also appear exactly TWICE in the tree, and
`visible="true"` matches nothing, so visibility filtering empties the probe.

Cause (iOS 26.5 sim, RN 0.86, PR-review Discussion tab, verified 2026-07-30):
- A RN View with `accessibilityLabel` (thread cards, header Pressables) becomes ONE accessibility
  element; its children are NOT XML descendants — they appear as geometric SIBLINGS elsewhere in
  the tree. Containment must be rect-in-rect on the page-source coordinates (`x/y/width/height`).
- Plain RN Texts are mirrored across two windows at identical rects — dedupe by
  (label,x,y,width,height) before counting, and never assert `count === 1` on a Text label
  (transiently or consistently 2). Interactive elements (Pressables with labels) appear once.
- Badge Texts using NativeWind `uppercase` expose the TRANSFORMED string (`RESOLVED`, `OUTDATED`,
  `FILE`) — match the uppercase form.
- Off-screen FlashList rows stay mounted in the tree; the `visible` attribute is useless (never
  `true`). Before coordinate-tapping a node, require `0 <= y && y+h <= screenHeight`; swipe
  (clamped, harmless) until the node is in the viewport.
- Diff-line gutters (line numbers, +/- markers) are `accessibilityElementsHidden`; the code
  container's `buildDiffLineAccessibilityLabel` (`Deleted line 8: ...`) is NOT what reaches the
  tree — the inner selectable RNText's raw code string is. Assert snippet content via code texts
  (`// stub change`, `return 1;`), and rely on screenshots for line-number evidence.
- Emoji labels (`👍 reaction, 2 reactions`) match fine through the helpers' predicate path.

Fix: parse page source into a rect tree (fast-xml-parser from the repo's `.pnpm` store requires
fine from scratch flows), keep `flat()` (dedupe) + `insideRect()` + `inViewport()` helpers, and
tap by node-rect centre via W3C actions instead of global `tapOn` when the same label exists in
several cards (e.g. `Resolve thread`).
