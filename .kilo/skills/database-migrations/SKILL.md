---
name: database-migrations
description: Create, review, apply, squash, or validate shared PostgreSQL migrations in this monorepo. Use when changing `packages/db/src/schema.ts`, generating Drizzle migrations, adding backfills, or checking migration bootstrap behavior.
---

# Shared PostgreSQL migrations

This skill covers shared PostgreSQL migrations only. It does not govern Durable Object SQLite or Wrangler migrations. Read `packages/db/AGENTS.md` first; it is canonical for shared PostgreSQL and Drizzle invariants. Use the `git-rebase` skill for migration conflicts during a rebase.

## Workflow

1. Read `packages/db/AGENTS.md` and inspect relevant schema and migration files.
2. Change `packages/db/src/schema.ts` first.
3. Generate artifacts with `pnpm drizzle generate`.
4. Inspect generated SQL.
5. Review generated DDL for destructive operations and data loss. Prefer
   additive or staged schema changes. If generated DDL is unsafe, wrong, or too
   broad, correct the schema and regenerate. Do not hand-edit generated DDL,
   snapshots, or journal entries.
6. Append only intentional `UPDATE` or `INSERT` data backfills after generated DDL, separated with `-->  statement-breakpoint`.
7. Apply migrations with `pnpm drizzle migrate` or run `pnpm drizzle:verify-bootstrap` when relevant.
8. Run `pnpm format` and targeted schema or migration checks.
9. Prefer one generated migration per unshipped feature branch. To squash
   migrations before shipping, remove the branch-local migration SQL, snapshots,
   and journal entries, then regenerate once from the current schema. Re-append
   intentional backfills afterward.

Keep generated artifacts generated. `packages/db/AGENTS.md` also covers shared-schema PII requirements and DB-backed timestamp serialization.
