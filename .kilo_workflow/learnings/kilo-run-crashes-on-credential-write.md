# kilo run crashes on its own credential write — void round, redispatch

Symptom: a dispatched role agent dies seconds after launch with `EXITCODE=1` and a Bun
stack trace instead of a verdict. The log's last lines are:

```
Error: Unexpected error
Failed query: update "credential" set "value" = ?, "time_updated" = ? where "credential"."id" = ?
  _tag: "EffectDrizzleQueryError",
Bun v1.3.14 (macOS arm64)
```

The sentinel check (`tail -2 "$LOG" | head -1`) returns the Bun version line, so the round
is void. No `~/.local/share/kilo/kilo-<branch>.db` is created — the crash happens before
the session store exists.

Cause: the CLI refreshes its OAuth token at startup and fails to **persist** the refreshed
credential. The token itself is fine (the `exp` in the logged payload is far in the future)
and auth is not wedged — only the SQLite write to the shared credential store fails, under
contention from the many `kilo run` processes parallel workflows keep alive on this machine
(`pgrep -af "kilo run"` showed 10+). Transient, not a state corruption.

Fix: treat it as an ordinary void round — discard it and dispatch a **fresh** session
(reviewers want a fresh session per round anyway). It counts toward the loop's round cap. A
redispatch of the identical handoff succeeded immediately.

Before redispatching, rule out the two failure modes that look identical but are not
transient, both cheap to check:

- **Disk full** — an SQLite write failure is the classic symptom. `df -h /Users`; the
  observed-healthy case had 180Gi available.
- **Auth genuinely wedged** — a different error (`PAID_MODEL_AUTH_REQUIRED`) that needs an
  interactive `kilo auth login` and will not clear on redispatch. If the logged credential
  payload carries a future `exp`, auth is not the problem.

Do **not** delete `~/.local/share/kilo/auth.json`, `account.json` or any `kilo-*.db`, and do
not kill another workflow's `kilo run` to free the lock — a foreign holder belongs to its own
workflow's monitor. Three consecutive void rounds from this signature is an infrastructure
blocker to report, not something to keep redispatching through.

Distinct from `kilo-run-exits-0-without-verdict.md`: that one is a mid-run provider stream
stall exiting 0 after real work; this one is a hard crash at startup exiting 1 with a stack
trace.
