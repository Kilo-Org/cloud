# mobile-e2e: multi-hour app session can stall tray refetch — force-stop + deep-link relaunch recovers

Symptom: on an app session that had been foregrounded for ~1.5h through many
Appium runs, newly seeded live cloud rows (visible in the
`activeSessions.list` tRPC replay) never rendered in the tray for 7+ minutes
of untouched watching. A tab bounce (Home -> Agents) rendered them instantly;
the same behavior repeated on departure (terminalized rows lingered).

Diagnosis: the app's 30s `refetchInterval` poll was running (nextjs logs show
`activeSessions.list` 200s), but the results were not applied to the rendered
tray until a navigation refetch. Never root-caused to product code — the SAME
flows on a freshly relaunched app worked untouched (appearance 30.9s,
departure ~40s, matching the iOS shard's 39.4s on identical code), so the
stall is a property of the long-lived app process state, not the build.

Fix: treat >1h-foreground app sessions as suspect. Recover with
`am force-stop com.kilocode.kiloapp` + the preflight deep link (adb reverses
first; see `mobile-android-dev-client-cold-start-deep-link.md`) — auth
survives (no `pm clear`), the bundle reloads in ~40s, and the tray polls
correctly again. Attribute findings to the product only after reproducing on a
fresh app session.

Related measurement tip: count the app's real poll traffic with
`grep -c "activeSessions.list" dev/logs/nextjs.log` over 60s — sibling shards'
apps poll the same nextjs, so measure once with your app force-stopped and
subtract the floor.
