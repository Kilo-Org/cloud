# mobile iOS: PR-link entry screen — Open button shifts +7pt when the field gains content (clear-X)

Symptom: verifying "invalid link renders INLINE in the reserved slot, Open button bounds
unchanged" by recording Open bounds on the empty entry screen, pasting `not-a-url`, and
re-measuring FAILS: Open moves y 236→243 and grows h 39→40 even though the helper slot is
documented as layout-stable.

Cause: the in-field clear-X (`Clear pull request link`, h-13/w-13 ≈ 46pt) appears whenever the
field has content; it is taller than the 39pt input, so the input ROW grows 39→46 and pushes the
helper slot and Open button down ~7pt. This is field-CONTENT state, not helper-message state —
the clear-X predates the pr-review-ux-7f22 changes (present at r1 head `dd659d4a9`).

Fix (decisive experiment for the slot invariant): hold field state constant across the helper
transition — paste `not-a-url` (helper visible, clear-X present), tap the clear-X: the shipped
clear handler does NOT clear `helperMessage`, so the invalid helper stays mounted with an empty
field, and Open returns EXACTLY to the initial rect ({x:21,y:236,w:360,h:39} on iPhone 17).
That byte-identical comparison is the assertion the AC intends; the +7pt with a filled field is
pre-existing approved behavior, not a regression.
