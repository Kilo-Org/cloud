# mobile: Maestro childOf never matches RN a11y cards on iOS — tap by bounds-derived point

Symptom: `tapOn: {text: 'Expand thread', childOf: {text: 'Discussion thread src/gamma.ts L33 (RIGHT)'}}`
fails with "Element not found: Text matching regex: Expand thread", while `maestro hierarchy`
clearly shows both labels on screen.

Cause: in Maestro's flattened iOS a11y tree, a RN View with `accessibilityLabel` (the thread card)
and the Pressables INSIDE it (`Expand thread`, `Unresolve thread`) are SIBLINGS at the same depth,
not parent/descendant — verified by walking the hierarchy JSON. `childOf` finds zero parents, and
the error misleadingly names the child selector.

Fix: parse `maestro --device <udid> hierarchy` output — every element carries `bounds` as
`[x1,y1][x2,y2]` — and `tapOn: {point: <center-x>,<center-y>}`. Verify positions with a fresh
hierarchy dump immediately before the point tap; positions were stable across repeated dumps.

Second trap: taps whose y is under the app's fixed header chrome are silently swallowed — Maestro
logs COMPLETED but nothing happens (same signature as the keyboard swallow). On the PR-review
screen the tab selector row ends at y≈166 (iPhone 17 Pro) and the effective dead zone extends to
about y≈178-180; a tap at y=174 was eaten, y=180 worked. When positioning a row for a header tap,
leave its control at y≳185; a collapsed thread card's expand control sits only 13pt below the card
top, so a "partially clipped at the list top" card's control is always inside the dead zone.

Also: Maestro text matching treats the pattern as regex — literal parens in labels like
`L33 (RIGHT)` still MATCH because the matching is not strict full-string in every code path
(`scrollUntilVisible` found the element with the unescaped pattern).
