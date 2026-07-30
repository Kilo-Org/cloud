# mobile e2e Android: RN LogBox badge intercepts tab-bar taps — dismiss the EXPANDED overlay, not just the badge

Symptom: `tapOn('Agents, tab, 3 of 4')` throws nothing, but the tab never
switches; the next wait times out. A hierarchy dump then shows an expanded
LogBox (`Component Stack`, `Copy`, `Dismiss`, `Minimize`,
`qualified-entry.js:20`).

Cause: a dev-mode RN warning (here "Can't perform a React state update...")
surfaces as a collapsed LogBox badge floating over the tab bar. UiAutomator2
`elementClick` resolves to a coordinate tap at the element's center; the badge
overlay intercepts the coordinates and EXPANDS the LogBox instead. Tapping
`Minimize` in a prior run is not enough — the collapsed badge persists and
keeps swallowing taps (a truncated grep of the dump can hide it: the badge's
content-desc is the full warning text, longer than typical head -20/60-char
filters).

Fix: loop until the dump is clean — if `Component Stack|Minimize` present tap
`Dismiss` (removes the notification permanently for the app session); else if
the warning text desc is present tap it to expand, then `Dismiss`. Verify with
`grep -c LogBox` == 0 before driving tabs. Dismissal survives across appium
sessions (same app process); it re-fires only on a fresh JS reload.
