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
journal entries. If generated DDL is wrong, correct the schema and regenerate.

Prefer `timestamp({ withTimezone: true })` over timestamps without time zone.
Review generated migrations for data loss. Prefer additive or staged schema
changes over destructive operations; when generated DDL is unsafe, revise the
schema and regenerate rather than editing generated artifacts.

Only intentional `UPDATE` or `INSERT` data backfills may be appended after the
generated DDL, separated with the exact marker `-->  statement-breakpoint`.
Prefer one generated migration per unshipped feature branch.

Load `database-migrations` for shared PostgreSQL migration work. Load
`git-rebase` for migration conflicts during a rebase.

## Lock safety

Deploys apply migrations against a database that is serving traffic, so DDL
competes with live queries for relation-level locks.

`DROP TABLE` and `ALTER TABLE` take `ACCESS EXCLUSIVE` on the target table **and
on every table the target references by foreign key**, because dropping the
constraint removes the referential-integrity trigger that lives on the parent.
A migration touching a table with foreign keys to `kilocode_users` and
`organizations` therefore locks both of those, and any concurrent query that
holds one while waiting for the other deadlocks. PostgreSQL then aborts whichever
party detects the cycle, which in practice is user requests rather than the
migration.

Two consequences when writing migrations against hot parent tables:

- Prefer dropping each foreign key in its own statement over one `DROP TABLE
  ... CASCADE`, so a single statement never needs `ACCESS EXCLUSIVE` on more
  than one busy table at a time. Once the constraints are gone, the table drop
  needs no lock on any parent.
- Migrations are applied by `pnpm drizzle:migrate-safely`, which sets
  `lock_timeout` below the server's `deadlock_timeout` so the migration loses
  the lock race instead of user queries, and retries lock failures. A migration
  that breaks out of the migrator's transaction with a bare `COMMIT;` (the
  `CREATE INDEX CONCURRENTLY` workaround) cannot be replayed, so it runs with
  retries disabled — keep those migrations small and expect no retry safety net.

The migrator applies every pending migration in one transaction, so locks taken
by the first statement are held until the last migration commits. Prefer one
migration per deploy over letting a batch accumulate.

The migrator decides what is pending by comparing each journal entry's `when`
against `max(created_at)` in `drizzle.__drizzle_migrations`, not by checking each
entry individually. A migration whose journal timestamp predates an
already-applied migration is skipped permanently and silently, which is a real
risk after a rebase or a long-lived branch. Confirm a new migration's `when` is
the newest in `meta/_journal.json` before merging.

When adding user or account PII to shared PostgreSQL, update `softDeleteUser` in
`apps/web/src/lib/user/index.ts` to delete or anonymize it and add corresponding
coverage in `apps/web/src/lib/user/index.test.ts`.

## Timestamp boundaries

Drizzle/PostgreSQL `timestamp({ withTimezone: true, mode: 'string' })` values
can have production shape `2026-04-29 01:16:12.945+00`, which strict ISO
validators such as `z.string().datetime()` reject. Before sending DB-backed
timestamps in strict HTTP, queue, or JSON contracts, normalize to UTC ISO, for
example `new Date(value).toISOString()` or an existing domain serializer.

Keep strict validators. Add regression fixtures with production-shaped
PostgreSQL timestamp text when changing these boundaries.
