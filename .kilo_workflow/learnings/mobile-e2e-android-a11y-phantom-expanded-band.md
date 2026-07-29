# mobile: Android Maestro hierarchy invents phantom-tall bounds for clamped expanded cards — verify with uiautomator text rows

Symptom: after expanding a PR-review thread whose header flew off-screen, `maestro
hierarchy` reports the card as e.g. `[37,444][1043,1496]` (a 1052px-tall band starting at
the a11y clamp edge), suggesting the card is merely clamped at top. `adb uiautomator dump`
on the same screen shows the truth: the card's tail (last comment + Reply row) ends ~y510
and the next thread starts at y520 — the reported 1052px band is phantom.

Consequence: never read expand-state or card geometry from Maestro bounds once the a11y
clamp (y=444 on pixel9 API35) is involved. The reliable probes:

- `adb shell uiautomator dump /sdcard/window.xml` — text rows keep true y per visible row;
  a thread's title ABSENT from the dump means its header is off-screen (the flow-4 failure
  signature). Identify which expanded thread a clamped tail belongs to by matching its
  comment text against the fixture (`grep body: server.mjs`), not by position.
- The thread's Expand/Collapse control DISAPPEARS from both dumps when its true bounds are
  fully above the clamp edge — a missing control is itself evidence the header is off-screen.

Tap geometry note (Android, same runs): the expand pressable is the title row — its band is
title-text-top +20 to +63 (e.g. title y555 → tappable ~555-598). Taps even ~10px below the
band hit the badge/meta row and silently do nothing; derive the tap point from the CURRENT
uiautomator title row (+35/+50), never from a stale dump or a previous thread's offsets.
