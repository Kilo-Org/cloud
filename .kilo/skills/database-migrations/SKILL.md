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
7. Check lock safety against live traffic before shipping DDL; see the section below.
8. Apply migrations with `pnpm drizzle migrate` locally, or `pnpm drizzle:migrate-safely` to rehearse the deploy path. Run `pnpm drizzle:verify-bootstrap` when relevant.
9. Run `pnpm format` and targeted schema or migration checks.
10. Prefer one generated migration per unshipped feature branch. To squash
    migrations before shipping, remove the branch-local migration SQL, snapshots,
    and journal entries, then regenerate once from the current schema. Re-append
    intentional backfills afterward.

Keep generated artifacts generated. `packages/db/AGENTS.md` also covers shared-schema PII requirements and DB-backed timestamp serialization.

## Lock safety review

`packages/db/AGENTS.md` is canonical; this is the checklist.

- Identify every table the DDL will lock with `ACCESS EXCLUSIVE`. That includes
  the target table **and every table it references by foreign key**, since
  dropping a constraint removes the referential-integrity trigger on the parent.
  A `DROP TABLE ... CASCADE` also locks the children whose constraints it drops.
- Treat `kilocode_users`, `organizations`, and `microdollar_usage` as always
  busy. A statement that needs `ACCESS EXCLUSIVE` on two of them at once will
  deadlock with ordinary traffic that touches both in the other order.
- Split such work so each statement locks at most one busy table: drop the
  foreign keys one statement at a time, then drop the table.
- Confirm the new journal `when` is the newest in `meta/_journal.json`, or the
  migrator will skip the migration silently.
- Verify with `SHOW deadlock_timeout` before changing `MIGRATION_LOCK_TIMEOUT`;
  the timeout must stay below it.

Query the locks a statement will take before shipping anything non-trivial:

```sql
select
  c.conname,
  src.relname as from_table,
  tgt.relname as to_table
from pg_constraint c
join pg_class src on src.oid = c.conrelid
join pg_class tgt on tgt.oid = c.confrelid
where c.contype = 'f'
  and 'YOUR_TABLE' in (src.relname, tgt.relname);
```
