# Worktree slug-hash port offset collides — with macOS AirPlay Receiver (5000/7000) or another worktree's live stack

Symptom: `pnpm dev:start` fails with `Refusing to share occupied worktree service ports: …`. Two observed occupants of the hash-chosen offset:

1. Offset 2000 (nextjs 5000) — `lsof -iTCP:5000` shows `ControlCe` (macOS AirPlay Receiver), which also holds 7000, even with no other dev stack running.
2. Offset 2400 — another worktree's live `kilo-dev-*` stack legitimately holds the ports; nothing is wrong with the machine, the hash just bucketed two worktrees onto the same offset.

Cause: `computePortOffset` derives the offset from the worktree slug hash (`KILO_PORT_OFFSET=auto` uses the same hash — it does not probe for free ports); a slug that buckets to 20 lands nextjs on 3000+2000=5000 permanently, and two slugs can bucket to the same offset. Only `dev:status` reads the offset back from the manifest, so `dev:start`/`dev:restart`/`dev:env` all recompute from the environment.

Fix: prefix every port-computing dev command with an explicit collision-free offset, e.g. `KILO_PORT_OFFSET=2100 pnpm dev:start ...` (2100 clears AirPlay: nextjs 5100, metro 10181, wrangler 10889+); 2900 is probe-verified against the same full service-port set (nextjs 5900, metro 10981, kiloclaw 11695, kilo-chat 11708, event-service 11709, session-ingest 11700). Probe before committing to an offset: compute every service port from it and check `lsof` — do not probe only the one port that errored. Per-command prefix only — never `export` it; `apps/mobile/e2e/AGENTS.md` forbids the export because stale shell values select the wrong bundle endpoints, and that rule stands. `dev:status`/`dev:seed`/`login.sh` are manifest- or DB-driven and need no prefix. Restate the prefix rule in every device-phase handoff; a `dev:restart` without it silently recomputes ports at the hash offset and breaks the stack's URL wiring.
