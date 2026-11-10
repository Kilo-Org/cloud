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
   it, so both must be lifted. The deploy job's `timeout-minutes` still caps
   how long the build can wait.
3. Precede each `CREATE ... INDEX CONCURRENTLY` with `DROP INDEX CONCURRENTLY
   IF EXISTS` for the same index name, so a retry rebuilds an `INVALID` index.
4. If the first transaction, before `COMMIT;`, contains DDL that fails when
   repeated (`CREATE TABLE`, `ADD COLUMN`, `ADD CONSTRAINT`), wrap that
   unchanged generated DDL in a `DO` block that skips it when its first created
   object exists. That transaction is atomic, so one object marks whether all
   of it applied. Skip this step when the migration only builds indexes.

`0314_scheduled_briefing_snapshots.sql` shows all four. Do not add `IF NOT
EXISTS` to the `CREATE ... INDEX CONCURRENTLY` statements instead of step 3: it
skips an `INVALID` index and leaves it broken.

To recover a deploy that is already failing on a concurrent-index migration:

- Check `drizzle.__drizzle_migrations` to confirm the migration is not recorded.
- Check `pg_index.indisvalid` for each of its indexes.
- Check `pg_stat_activity` for long-running transactions.
- Then make the unrecorded migration retry-safe as above. Editing it is safe
  because drizzle only compares the newest recorded migration timestamp.

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
generated DDL, separated with the exact marker `-->  statement-breakpoint`.
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
