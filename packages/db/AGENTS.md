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

For shared-schema PII additions, follow root `AGENTS.md`'s `softDeleteUser` and
corresponding test invariant; do not duplicate that rule here.

## Timestamp boundaries

Drizzle/PostgreSQL `timestamp({ withTimezone: true, mode: 'string' })` values
can have production shape `2026-04-29 01:16:12.945+00`, which strict ISO
validators such as `z.string().datetime()` reject. Before sending DB-backed
timestamps in strict HTTP, queue, or JSON contracts, normalize to UTC ISO, for
example `new Date(value).toISOString()` or an existing domain serializer.

Keep strict validators. Add regression fixtures with production-shaped
PostgreSQL timestamp text when changing these boundaries.
