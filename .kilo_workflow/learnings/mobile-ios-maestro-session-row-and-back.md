# mobile-ios-maestro-session-row-and-back

Symptom: on iOS, a Maestro flow that matches the Agents session row and navigates
back fails two ways: (1) `visible: '<session title>'` never matches even though the
row renders; (2) the `back` command does not leave a pushed session-detail screen.

Cause: iOS exposes the session row as ONE accessibility element whose label is the
comma-joined summary (`Hermes-mem-c716 baseline session setup, CLOUD, cost 5 cents,
6 hours ago, from CLI`), not the bare title; and Maestro's `back` is a no-op on this
pushed screen — the app renders an explicit `Go back` accessibility element instead.

Fix: match with a prefix regex (`'<title>,.*'`) and tap `Go back` to return. Also
make reruns self-normalizing: start with an optional `Go back` tap and a
Home-tab gate before driving tabs.

Bonus zsh trap: `"$CLI:relay"` expands as `$CLI` with zsh's `:r` modifier plus
literal `elay` (target becomes `<session>elay`, tmux "can't find pane"). Always
brace: `"${CLI}:relay"`.
