# mobile: tray-row assertions must be region-scoped — same session renders in tray AND history

Symptom: an E2E departure assertion ("row leaves Active now") fails even though the row
correctly departed the tray, or passes even though it never departed.

Cause: the same session id renders in TWO places — the "Active now" tray while live and the
history sections below it once departed — and both rows expose the SAME composite
accessibility label (`<title>, <EYEBROW>, <meta>[, from <PLATFORM>]`). The Appium helpers
match full-string regexes against labels anywhere in the hierarchy, so a title pattern
matches whichever copy exists. A departure flow that waits for "not visible" can never win
while the history copy renders; a flow that asserts "still visible" passes on the history
copy even if the tray copy is stuck.

Fix: scope by position, not text. In JS flows, `h.findAll(pattern)` + `driver.getElementRect`
and compare y against a region anchor: tray rows sit ABOVE the expander
(`/more active sessions|Show fewer active sessions/`) or, when there is no expander, above the
first history section header (`/Today|TODAY|Yesterday/`). Example in this round's scratch
(`case1d2.js`): row departs the tray when `rowY == null || rowY >= trayBottomY`, then the same
title must still match somewhere below (history landing).

Two adjacent gotchas from the same round:

- Labels are COMPOSITE: always match with a trailing `.*`
  (`/E2E iOS cloud one.*/`), never the bare title — the bare title full-string-matches nothing
  and the flow times out while the row is plainly on screen.
- "Renamed row lands in history": assert `rowY > historyHeaderY` AFTER the departure bound
  (~50s), not just visibility — the lingering tray copy matches first.
