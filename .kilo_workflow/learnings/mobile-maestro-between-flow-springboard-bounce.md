# mobile: SpringBoard bounce between consecutive maestro runs (iOS26, load)

Refines `.kilo_workflow/learnings/mobile-ios26-maestro-under-load.md` item 1
("failed/killed flows leave the app at SpringBoard"). Observed 2026-07-28 in
mobile-ui-ddc7 r5 (load avg high, 3 concurrent stacks):

- A **successful** flow (`logout.sh`, final assert COMPLETED, app left on the
  login screen) followed immediately by a second `maestro test` found the app
  back at SpringBoard: the second run's flow-start `launchApp` bounced the dev
  client to the home screen. First assert (`you@example.com`) failed;
  hierarchy showed SpringBoard text only (`Page 2 of 2`, icon labels).
- Recovery that worked (same as the committed learning's icon-tap rule): a
  tiny scratch flow `stopApp` → conditional `tapOn: {text: 'Kilo'}` (home
  icon) → `extendedWaitUntil` the prior screen's known element (route
  persistence returned to the login screen), then rerun the real flow
  immediately. Never `launchApp` as the recovery.
- Practical rule for multi-flow rounds: after any flow boundary, do not assume
  the app is still foreground — gate the next flow on a known element and
  recover via the icon tap, not by rerunning the same flow blindly.
