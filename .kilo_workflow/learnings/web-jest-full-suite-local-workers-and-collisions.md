# Running the full web jest suite locally: workers, timeouts, and run collisions

**Symptom 1 — mass per-test 5s timeouts and 60s `beforeAll` hook timeouts across
unrelated suites when running `pnpm --filter web test` locally.** The failures name
`workerSetup.ts` `beforeAll` or `cleanupDbForTest` in `beforeEach`, in suites far from
whatever you changed.

**Cause.** `apps/web/jest.config.ts` defaults to `maxWorkers: '50%'`. Every worker's
first suite cold-starts a per-worker database
(`DROP DATABASE … WITH (FORCE)` + `CREATE DATABASE` + full drizzle migrate + partition
provisioning, `apps/web/src/tests/setup/workerSetup.ts`). On a laptop docker postgres,
N parallel cold starts exceed the hardcoded 60s hook timeout; the setup flag file is
only written after success, so every subsequent suite re-runs the full setup and times
out again — the whole run is poisoned from the start. Even after setup, 200-table
`TRUNCATE` cleanup per test can exceed the 5s default test timeout under load.

**Fix.** Run the full suite as `JEST_MAX_WORKERS=1 pnpm --filter web test` with nothing
else DB-heavy on the machine, and expect it to take hours (~680 suites). Per-file
(`pnpm --filter web test -- <file>`) runs are fine with default workers. If a full-run
failure is in a suite your diff does not touch, re-run that suite alone before
believing it.

**Symptom 2 — a second concurrent DB-test run crashes with `ERR_UNHANDLED_ERROR` /
`Connection terminated unexpectedly`, and both runs produce garbage results.**

**Cause.** With `JEST_MAX_WORKERS=1` (or any equal worker count), both runs use the
same `JEST_WORKER_ID`s and therefore the SAME `postgres-<workerId>` databases: each
run's setup `DROP DATABASE … WITH (FORCE)` terminates the other run's connections
mid-flight.

**Fix.** Never run two web jest invocations (or anything else using the shared
docker postgres test setup) concurrently on one worktree. One DB-test run at a time,
machine-wide.
