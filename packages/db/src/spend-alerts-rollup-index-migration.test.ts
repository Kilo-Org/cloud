/**
 * The spend-alert hourly rollup scans `microdollar_usage` over a `created_at`
 * range and reads exactly `kilo_user_id`, `organization_id` and `cost`, so a
 * covering index whose leading column is `created_at` makes that scan
 * index-only. Two properties of the generated migration need to keep holding:
 *
 *  - the index is built CONCURRENTLY. A plain `CREATE INDEX` takes a
 *    write-blocking lock for the whole build on a ~1.6B-row table.
 *  - the migration carries no unrelated DDL. Running `drizzle-kit generate` on
 *    this tree also emits the `repository_customizations` drift left by the
 *    duplicated `0255_*` prefixes; the table is already dropped by
 *    0255_drop_repository_customizations.sql, so replaying the drop fails.
 *
 * Like `migration-journal.test.ts` this reads generated files only, so it
 * needs no database and runs in the DB-less `workspace-tests` matrix. It
 * locates the migration by tag rather than journal position — the pattern
 * `user-activity-token-singleton-migration.test.ts` established — so an
 * unrelated migration appended later does not make the guard stale.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_MIGRATION_TAG = 'spend_alerts_rollup_covering_index';
const INDEX_NAME = 'idx_microdollar_usage_created_at_rollup';
// The rollup's range predicate reads these columns, in this order.
const ORDERED_COLUMNS = '"created_at","kilo_user_id","organization_id","cost"';

type JournalEntry = { idx: number; tag: string };

function readRollupMigration(): { tag: string; sql: string } {
  const migrationsDir = path.join(__dirname, 'migrations');
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf-8')
  ) as { entries: JournalEntry[] };

  const entry = journal.entries.find(candidate => candidate.tag.endsWith(INDEX_MIGRATION_TAG));
  if (!entry) {
    throw new Error(`journal is missing ${INDEX_MIGRATION_TAG}`);
  }
  return {
    tag: entry.tag,
    sql: fs.readFileSync(path.join(migrationsDir, `${entry.tag}.sql`), 'utf-8'),
  };
}

describe('spend-alert rollup covering index migration', () => {
  it('builds the covering index concurrently over the scanned columns in order', () => {
    const { sql } = readRollupMigration();

    expect(sql).toContain(`CREATE INDEX CONCURRENTLY "${INDEX_NAME}"`);
    expect(sql).toContain('ON "microdollar_usage"');
    expect(sql).toContain(`(${ORDERED_COLUMNS})`);
  });

  it('takes no blocking CREATE INDEX or ALTER TABLE lock on microdollar_usage', () => {
    const { sql } = readRollupMigration();

    // Strip the allowed concurrent form; any remaining CREATE INDEX is a
    // plain, lock-taking build.
    const withoutConcurrent = sql.replace(/CREATE (?:UNIQUE )?INDEX CONCURRENTLY/g, '');
    expect(withoutConcurrent).not.toMatch(/CREATE (?:UNIQUE )?INDEX\b/);
    expect(sql).not.toMatch(/ALTER TABLE\s+"?microdollar_usage"?/);
  });

  it('wraps the concurrent build in the migrator transaction boundaries', () => {
    const { sql } = readRollupMigration();

    // This repository's transactional migrator needs the concurrent statement
    // outside a transaction: COMMIT; immediately before, BEGIN; after.
    expect(sql.trimStart().startsWith('COMMIT;')).toBe(true);
    expect(sql.trimEnd().endsWith('BEGIN;')).toBe(true);
  });

  it('leaves out the unrelated repository_customizations drift', () => {
    const { sql } = readRollupMigration();

    expect(sql).not.toContain('repository_customizations');
    expect(sql).not.toMatch(/DROP TABLE/);
  });
});
