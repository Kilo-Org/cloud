# mobile: Maestro `direction: DOWN` swipe is eaten by a sticky FlashList header overlay

Symptom: on a list with `stickyHeaderIndices` (PR-review Files tab), swipes that scroll
content DOWN (offset decreases, e.g. `direction: DOWN` or start≈30% end≈70%) silently do
nothing — Maestro logs COMPLETED, hierarchy is byte-identical. Up-swipes work fine.

Cause: FlashList's StickyHeaders overlay is an absolute-positioned sibling ON TOP of the
list, not part of the scroll content. A gesture starting inside the overlay's frame (on the
PR Files screen it sits at the list top, y≈233-267 ≈ 27-30% of an 874pt screen) does not
scroll the list. Maestro's directional DOWN swipe starts near y≈30%, inside the overlay.

Fix: use explicit-coordinate swipes whose start is below the overlay
(`start: 50%, 40%` → `end: 50%, 75%`). Verify movement with a before/after hierarchy grep
(bounds of a stable row). Note: real users dragging from the stuck header row hit the same
non-scrollable strip — standard FlashList StickyHeaders behavior, not a defect to report
unless the product wants drag-from-header scrolling.
