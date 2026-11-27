# Shared PostgreSQL database

This package owns shared PostgreSQL schema and Drizzle conventions. It does not
govern Durable Object SQLite or Wrangler migrations; follow the owning service
instructions and Durable Objects/Workers skills for those.

## Locations

- Schema: `packages/db/src/schema.ts`
- Generated migrations: `packages/db/src/migrations/`
- Generated migration metadata, snapshots, and journal: `packages/db/src/migrations/meta/`
- Drizzle configuration: `packages/db/drizzle.config.ts`
- Schema migration-consistency test: `packages/db/src/schema.test.ts`

## Schema and migrations

Change `packages/db/src/schema.ts` first, then generate migrations with
`pnpm drizzle generate`. Do not hand-write or edit generated DDL, snapshots, or
journal entries, except in the cases that this section lists. If generated DDL
is wrong, correct the schema and regenerate.

For an index declared with Drizzle's `.concurrently()`, the generated SQL may
receive only the hand edits below, which make the migration work with this
repository's transactional migrator and safe to retry. Do not alter the
generated index definition, name, or expression; leave snapshots, journal, and
all other generated DDL untouched. This narrow exception is not permission to
hand-edit arbitrary generated DDL.

A concurrent build can be cancelled on any table, not only a large one. It
waits for every transaction that was open when it started, on any table, so a
long-running query elsewhere on the primary (for example an analytics sync)
stalls it until the server default `statement_timeout` cancels it. A cancelled
build leaves an `INVALID` index under its name and has already committed the
migration's first transaction, but the migration is not recorded. Production
deploys then fail on every retry until the migration is fixed. Every
concurrent-index migration must therefore survive a retry:

1. Add `COMMIT;` immediately before and `BEGIN;` immediately after the unchanged
   generated `CREATE [UNIQUE] INDEX CONCURRENTLY` statement group, each
   separated with `--> statement-breakpoint`.
2. Add `SET statement_timeout = 0;` and `SET lock_timeout = 0;` after
   `COMMIT;`, and `RESET lock_timeout;` and `RESET statement_timeout;` before
   `BEGIN;`. A concurrent build waits on older transactions through lock
   waits, and a server default `statement_timeout` or `lock_timeout` cancels
   it, so both must be lifted. Through the migration proxy, its run deadline
   (6 hours) caps how long the build can wait; the deploy job's
   `timeout-minutes` does not stop it. A `db-gate` that still runs
   `drizzle-kit migrate` itself is capped by its `timeout-minutes`.
3. Precede each `CREATE ... INDEX CONCURRENTLY` with `DROP INDEX CONCURRENTLY
   IF EXISTS` for the same index name, so a retry rebuilds an `INVALID` index.
4. Keep the first transaction, before `COMMIT;`, to DDL that locks only objects
   the migration creates: new tables, their indexes, and foreign keys between
   new tables. Wrap that unchanged generated DDL in a `DO` block that skips it
   when its first created object exists. That transaction is atomic, so one
   object marks whether all of it applied. Skip this step when the migration
   only builds indexes.
5. Give every generated statement that locks an existing table its own
   transaction (`BEGIN;` … `COMMIT;`), placed after the first transaction and
   before the concurrent-index group. That covers `ADD COLUMN`, an added foreign
   key to an existing table, and any other `ALTER` on an existing table. Guard
   each statement on its own catalog state, such as `pg_attribute` for a column,
   so a retry skips it without taking a lock. Give each such transaction
   `SET LOCAL lock_timeout` and retry a bounded number of times inside its `DO`
   block. A transaction that waits for a lock on one busy table while it holds a
   traffic-blocking lock on another deadlocks with live traffic that locks the
   two tables in the opposite order, and PostgreSQL kills one side. A failed
   attempt releases its lock request, so the retry loop stalls traffic for at
   most the timeout per attempt. Do not use `ADD COLUMN IF NOT EXISTS` as the
   guard: it takes the lock before it checks the column.

`0314_scheduled_briefing_snapshots.sql` shows the first four, and
`0370_anthropic_user_profiles.sql` shows the fifth. Do not add `IF NOT
EXISTS` to the `CREATE ... INDEX CONCURRENTLY` statements instead of step 3: it
skips an `INVALID` index and leaves it broken.

To recover a deploy that is already failing on a concurrent-index migration:

Staging's `db-gate` migrates through the migration proxy
(`services/migration-proxy`); production's still runs `drizzle-kit migrate`
with `POSTGRES_URL` until it switches the same way. The proxy steps below apply
to every environment whose `db-gate` calls the proxy.

- Read the failed run in the `db-gate` job log: the migration proxy's run view
  (`services/migration-proxy/README.md`) gives `failure.code`, `sqlstate`,
  `migrationTag` and the `applied` and `pending` tags. The view never carries
  the Postgres message; read it in the proxy Worker's logs (Workers Logs for
  `migration-proxy` or `migration-proxy-staging`, kept 7 days) or in the
  provider's Postgres log. Where `db-gate` still runs `drizzle-kit migrate`,
  the provider's Postgres log is the only place that names the error:
  `drizzle-kit migrate` exits with status 1 without printing it.
- Check `drizzle.__drizzle_migrations` to confirm the migration is not recorded.
- Check `pg_index.indisvalid` for each of its indexes.
- For a proxy run that fails with `invalid_index_present`, the run lists the
  invalid indexes in `failure.indexes`: the proxy refuses to migrate while an
  `INVALID` index exists, so the migration's own `DROP` never runs. Check that
  no build is running on each one (`SELECT * FROM
  pg_stat_progress_create_index`), then run `DROP INDEX CONCURRENTLY <name>` in
  the SQL editor and redeploy.
- Check `pg_stat_activity` for long-running transactions.
- Check `pg_stat_activity` for a `CREATE INDEX CONCURRENTLY` left behind by a
  lost proxy run or a cancelled `drizzle-kit migrate` job. A blocked index
  build does not notice that its client disconnected, and it holds `SHARE
  UPDATE EXCLUSIVE` on the table, so a retry waits behind it without a limit.
  The proxy ends its own leftover sessions before the next run
  (`leftover_not_ended` when one does not end); a build left by any other
  client, including a cancelled `drizzle-kit migrate` job, must be ended by
  hand.
- Then make the unrecorded migration retry-safe as above. Editing it is safe
  because drizzle only compares the newest recorded migration timestamp.

While migrations are failing, do not redeploy or promote a deployment from the
Vercel UI. `deploy-production.yml` promotes only after its migration job
succeeds, so a failed run leaves a staged but unpromoted deployment whose code
expects the unapplied schema. Promoting or redeploying it from Vercel skips that
check and breaks production. The `Redeploy Web to Production` workflow
(`redeploy-web.yml`) does not run migrations either. Fix the migration and rerun
`Deploy to Production` instead.

Prefer `timestamp({ withTimezone: true })` over timestamps without time zone.
Review generated migrations for data loss. Prefer additive or staged schema
changes over destructive operations; when generated DDL is unsafe, revise the
schema and regenerate rather than editing generated artifacts.

Drop a table or column only after the deployed code no longer uses it. If a
dropped table has foreign keys to busy tables, the generated `DROP TABLE ...
CASCADE` locks the dropped table and every referenced table in one
transaction. That can deadlock with live writers. As an exception to the rules
above, you can hand-write this case:
drop each foreign key in its own transaction (`COMMIT;` / `BEGIN;`), then drop
the tables and columns. Set `SET LOCAL lock_timeout` in each transaction, use
`IF EXISTS` on every statement so a partial run can be retried, and leave the
snapshot and journal as generated. See `0317_drop_briefing_legacy_objects.sql`.

Only intentional `UPDATE` or `INSERT` data backfills may be appended after the
generated DDL, separated with the exact marker `--> statement-breakpoint`.
Prefer one generated migration per unshipped feature branch.

Load `database-migrations` for shared PostgreSQL migration work. Load
`git-rebase` for migration conflicts during a rebase.

When adding user or account PII to shared PostgreSQL, update `softDeleteUser` in
`apps/web/src/lib/user/index.ts` to delete or anonymize it and add corresponding
coverage in `apps/web/src/lib/user/index.test.ts`.

## User IDs

A user ID is NOT always a UUID. It is an arbitrary string that may be a UUID or
another format; OAuth user IDs usually start with the prefix `oauth/`. This is
why `kilocode_users.id` and every user-ID reference (for example
`kilo_user_id`, `user_id`) is a `text()` column rather than `uuid()`. Do not
assume the UUID shape: avoid UUID validation, parsing, or `uuid()`-typed
columns and `::uuid` casts on user IDs, since they break for OAuth users.

## Timestamp boundaries

Drizzle/PostgreSQL `timestamp({ withTimezone: true, mode: 'string' })` values
can have production shape `2026-04-29 01:16:12.945+00`, which strict ISO
validators such as `z.string().datetime()` reject. Before sending DB-backed
timestamps in strict HTTP, queue, or JSON contracts, normalize to UTC ISO, for
example `new Date(value).toISOString()` or an existing domain serializer.

Keep strict validators. Add regression fixtures with production-shaped
PostgreSQL timestamp text when changing these boundaries.
