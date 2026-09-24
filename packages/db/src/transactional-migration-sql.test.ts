/**
 * File-only guard: drizzle-orm's migrator wraps every migration in one
 * transaction, so an unwrapped `CREATE INDEX CONCURRENTLY` fails CI with
 * "cannot run inside a transaction block". This suite asserts the rewriter
 * injects the COMMIT;/BEGIN; wrap the migrator needs, including on
 * 0255_ambiguous_shocker (an applied file we must not edit).
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  STATEMENT_BREAKPOINT,
  rewriteMigrationSqlForTransactionalMigrator,
  writeTransactionalMigrationsFolder,
} from './transactional-migration-sql';

const CONCURRENT_INDEX =
  /(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX)\s+CONCURRENTLY/i;
const COMMIT = /^COMMIT\b/i;
const BEGIN = /^BEGIN\b/i;

function assertConcurrentRunsOutsideTransaction(sql: string, label: string) {
  let inTransaction = true;
  for (const chunk of sql.split(STATEMENT_BREAKPOINT)) {
    const statement = chunk.trim();
    if (!statement) {
      continue;
    }
    if (CONCURRENT_INDEX.test(statement) && inTransaction) {
      throw new Error(
        `${label}: "${statement.slice(0, 80)}" runs inside the migrator's transaction`
      );
    }
    if (COMMIT.test(statement)) {
      inTransaction = false;
    } else if (BEGIN.test(statement)) {
      inTransaction = true;
    }
  }
  if (!inTransaction) {
    throw new Error(`${label}: concurrent-index group is not followed by BEGIN;`);
  }
}

describe('rewriteMigrationSqlForTransactionalMigrator', () => {
  it('wraps an unwrapped concurrent-index group in COMMIT;/BEGIN;', () => {
    const sql = [
      'ALTER TABLE "t" ADD COLUMN "x" text;',
      'CREATE UNIQUE INDEX CONCURRENTLY "i" ON "t" USING btree ("x");',
      'ALTER TABLE "t" ADD CONSTRAINT "c" CHECK (true);',
    ].join(`${STATEMENT_BREAKPOINT}\n`);

    const rewritten = rewriteMigrationSqlForTransactionalMigrator(sql);

    expect(rewritten).toContain('COMMIT;');
    expect(rewritten).toContain('BEGIN;');
    assertConcurrentRunsOutsideTransaction(rewritten, 'fixture');
    expect(rewritten).toContain('ALTER TABLE "t" ADD COLUMN "x" text;');
    expect(rewritten).toContain('ALTER TABLE "t" ADD CONSTRAINT "c" CHECK (true);');
  });

  it('does not double-wrap a file that already commits before CONCURRENTLY', () => {
    const sql = [
      'COMMIT;',
      'CREATE UNIQUE INDEX CONCURRENTLY "i" ON "t" USING btree ("x");',
      'BEGIN;',
    ].join(`${STATEMENT_BREAKPOINT}\n`);

    const rewritten = rewriteMigrationSqlForTransactionalMigrator(sql);
    const commits = rewritten.match(/COMMIT;/g) ?? [];
    const begins = rewritten.match(/BEGIN;/g) ?? [];
    expect(commits).toHaveLength(1);
    expect(begins).toHaveLength(1);
    assertConcurrentRunsOutsideTransaction(rewritten, 'already-wrapped');
  });

  it('makes 0255_ambiguous_shocker safe without editing the applied file', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'migrations', '0255_ambiguous_shocker.sql'),
      'utf8'
    );
    expect(CONCURRENT_INDEX.test(source)).toBe(true);
    expect(() => assertConcurrentRunsOutsideTransaction(source, '0255-source')).toThrow(
      /runs inside the migrator's transaction/
    );

    const rewritten = rewriteMigrationSqlForTransactionalMigrator(source);
    assertConcurrentRunsOutsideTransaction(rewritten, '0255-rewritten');
    expect(source.includes('COMMIT;')).toBe(false);
  });
});

describe('writeTransactionalMigrationsFolder', () => {
  it('rewrites every journal SQL so concurrent indexes run outside a transaction', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'txn-migrations-'));
    writeTransactionalMigrationsFolder(path.join(__dirname, 'migrations'), dest);

    const journal = JSON.parse(
      fs.readFileSync(path.join(dest, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { tag: string }[] };

    expect(journal.entries.length).toBeGreaterThan(0);
    for (const entry of journal.entries) {
      const sql = fs.readFileSync(path.join(dest, `${entry.tag}.sql`), 'utf8');
      if (!CONCURRENT_INDEX.test(sql)) {
        continue;
      }
      assertConcurrentRunsOutsideTransaction(sql, entry.tag);
    }
  });
});
