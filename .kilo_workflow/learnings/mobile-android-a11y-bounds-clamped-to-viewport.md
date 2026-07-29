# mobile: Android a11y bounds are clamped to the visible viewport — clip probes need pixels or control offsets

Symptom: on Android, `maestro hierarchy` bounds for a partially off-screen React Native
card report only the VISIBLE band (clamped at the screen's content edge, e.g. y=444 on a
2560px-tall emulator), unlike iOS which reports window/content coordinates past the edge.
Consequences for E2E geometry probes:

- A card's true top cannot be read once it crosses the viewport edge; repeated dumps show
  the card "stuck" at the edge value. Compute the true top from a child control's reported
  offset (PR-review thread cards: control row sits ~35px below the card's true top).
- Taps on a control whose band is clamped to a few px (e.g. reported `[72,444][775,453]`)
  are unreliable and usually miss — Maestro and ADB/uiautomator taps alike.
- Zero-motion assertions remain valid with clamped bands: if neither the card's true rect
  nor the viewport moved, the clamped band is byte-identical; any true motion changes it.

For header-visibility questions (does a title render behind the app chrome), don't trust
a11y at all: take a screenshot and scan pixels — locate the card background color's first
visible row and count dark text pixels in the header band (PR-review card bg is
(240,238,230), page bg (251,250,245); the chrome is opaque, not blurred).
