# mobile: scrollUntilVisible throws "scrolled N times without finding" but lands on the target

Symptom: `scrollUntilVisible('<full label>')` throws after exhausting maxScrolls, yet a
hierarchy dump taken immediately after shows the target fully visible and correctly
positioned (observed twice on iOS PR-review Discussion tab, pr-review-ux-7f22).

Cause: the helper checks visibility between flicks; the final flick moves the list
past the last check point (momentum + FlashList re-layout), so the loop exhausts while
the end state is fine. It is the same flick-overshoot family as
`mobile-e2e-top-clip-positioning-flashlist-clamp` — not a new defect.

Fix: after a failed scrollUntilVisible, dump the hierarchy before retrying or
classifying — the target is often already on screen. For flows that must not throw,
wrap in `.catch(() => {})` and follow with an explicit `assertVisible` probe.
