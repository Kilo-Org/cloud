# iOS Settings text-size slider: reliable Maestro swipe technique

Symptom: restoring Settings > Display & Brightness > Text Size from 100% (XXXL) back to the
default via Maestro swipe keeps failing — swipes from the right edge (91%/98% starts) and track
taps do not move the thumb.

Cause: at 100% the slider thumb sits at roughly 78% of track width, not at the right edge; a swipe
that starts right of the thumb grabs empty track. Taps on the track do not reposition this slider.

Fix: swipe with unquoted integer percentages (Maestro 2.7.0 rejects quoted values), starting ON
the thumb: `swipe: { start: 78%, 89% ... end: 10%, 89% }` style coordinates (adjust the y to the
slider row), then verify visually with a screenshot — the a11y tree does not expose the slider
value reliably. Same technique drives the slider up to 100% (start at the current thumb position,
e.g. 50% for the L default).
