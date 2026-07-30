# mobile/android: RN a11y-label container nodes are LEAVES — group card content by geometric containment

Symptom: an Appium page-source parse shows a PR-review thread card's label node
(`Discussion thread ...`) with its full card bounds but ZERO children; the snippet,
comments, and pills look "outside" the card when checked by XML parentage.

Cause: on Android (uiautomator2), React Native hoists a labeled container's accessible
children to siblings in the flattened a11y tree; the label node keeps the card's rect
but stays a leaf.

Fix: assign content to cards GEOMETRICALLY — a node belongs to the card whose
label-node rect contains it (`inside(cardRect, nodeRect)` with a 2px tolerance). Works
with the viewport-clamp learning (clamped bands still nest). Two companion traps:
`scrollUntilVisible` stops the instant the label peeks past the clamp edge — the card's
header controls are not necessarily rendered yet, so swipe in a bounded loop until the
card's own control is INSIDE its rect; and after a settle swipe, re-query rects (the
card moved) — a stale rect in a swipe loop reads as missing content. Expansion state is
component state and survives Appium sessions: remount the tab (tap sibling tab, tap
back) at flow start when a flow depends on default expansion.
