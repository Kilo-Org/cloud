# Worktree slug hashing to port offset 2000 collides with macOS AirPlay Receiver (5000/7000)

Symptom: `pnpm dev:start` fails with `Refusing to share occupied worktree service ports: nextjs:5000` even with no other dev stack running; `lsof -iTCP:5000` shows `ControlCe` (macOS AirPlay Receiver), which also holds 7000.

Cause: `computePortOffset` derives the offset from the worktree slug hash (`KILO_PORT_OFFSET=auto` uses the same hash — it does not probe for free ports); a slug that buckets to 20 lands nextjs on 3000+2000=5000 permanently. Only `dev:status` reads the offset back from the manifest, so `dev:start`/`dev:restart`/`dev:env` all recompute from the environment.

Fix: prefix every port-computing dev command with an explicit collision-free offset, e.g. `KILO_PORT_OFFSET=2100 pnpm dev:start ...` (2100 clears AirPlay: nextjs 5100, metro 10181, wrangler 10889+). `dev:status`/`dev:seed`/`login.sh` are manifest- or DB-driven and need no prefix. Restate the prefix rule in every device-phase handoff; a `dev:restart` without it silently recomputes ports at the hash offset and breaks the stack's URL wiring.
