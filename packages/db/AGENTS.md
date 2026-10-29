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
receive only the transaction boundaries needed by this repository's
transactional migrator: add `COMMIT;` immediately before and `BEGIN;`
immediately after the unchanged generated `CREATE [UNIQUE] INDEX CONCURRENTLY`
statement group, each separated with `--> statement-breakpoint`. Do not alter
the generated index definition, name, or expression; leave snapshots, journal,
and all other generated index DDL untouched. This narrow exception is not
permission to hand-edit arbitrary generated DDL.

Do not automatically add `IF NOT EXISTS` to concurrent-index migrations. If a
concurrent build fails, first inspect the index state; recover an invalid index
explicitly with `DROP INDEX CONCURRENTLY` or `REINDEX INDEX CONCURRENTLY` as
appropriate before retrying. `IF NOT EXISTS` can mask an invalid index.

A second exception covers a long concurrent build on a large table. The
production server sets a default `statement_timeout` that cancels such a build.
Add `SET statement_timeout = 0;` after `COMMIT;` and `RESET statement_timeout;`
before `BEGIN;`. A cancelled build still commits the migration's first
transaction without recording the migration, so a retry must not fail on DDL
that already applied. You can wrap that transaction's unchanged generated DDL in
a `DO` block that skips it when its first created object exists, as
`0314_scheduled_briefing_snapshots.sql` does. Precede the build with
`DROP INDEX CONCURRENTLY IF EXISTS`. Leave the snapshot and journal untouched.

Prefer `timestamp({ withTimezone: true })` over timestamps without time zone.
Review generated migrations for data loss. Prefer additive or staged schema
changes over destructive operations; when generated DDL is unsafe, revise the
schema and regenerate rather than editing generated artifacts.

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
