/**
 * The webhook verified-link gate updates `cli_sessions_v2` by
 * `(git_url, pr_number)`. The only other session index starts with `git_url`,
 * so without a matching index every pull_request/pull_request_review delivery
 * range-scans every session in the repository and heap-fetches each row to
 * test `pr_number` and the head evidence. This guard keeps the generated
 * migration building exactly that index:
 *
 *  - the index is built CONCURRENTLY. A plain `CREATE INDEX` takes a
 *    write-blocking lock for the whole build on a large session table.
 *  - the key is `(git_url, pr_number)`, not the branch index.
 *
 * Like `migration-journal.test.ts` it reads generated files only, so it needs
 * no database and runs in the DB-less `workspace-tests` matrix. It locates the
 * migration by tag rather than journal position so a later migration does not
 * make the guard stale.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const INDEX_MIGRATION_TAG = 'cli_sessions_git_url_pr_number_index';
const INDEX_NAME = 'IDX_cli_sessions_v2_git_url_pr_number';
const ORDERED_COLUMNS = '"git_url","pr_number"';

type JournalEntry = { idx: number; tag: string };

function readIndexMigration(): { tag: string; sql: string } {
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

describe('cli_sessions_v2 (git_url, pr_number) index migration', () => {
  it('builds the index concurrently over the webhook gate columns in order', () => {
    const { sql } = readIndexMigration();

    expect(sql).toContain(`CREATE INDEX CONCURRENTLY "${INDEX_NAME}"`);
    expect(sql).toContain('ON "cli_sessions_v2"');
    expect(sql).toContain(`(${ORDERED_COLUMNS})`);
  });

  it('takes no blocking CREATE INDEX or ALTER TABLE lock on cli_sessions_v2', () => {
    const { sql } = readIndexMigration();

    // Strip the allowed concurrent form; any remaining CREATE INDEX is a
    // plain, lock-taking build.
    const withoutConcurrent = sql.replace(/CREATE (?:UNIQUE )?INDEX CONCURRENTLY/g, '');
    expect(withoutConcurrent).not.toMatch(/CREATE (?:UNIQUE )?INDEX\b/);
    expect(sql).not.toMatch(/ALTER TABLE\s+"?cli_sessions_v2"?/);
  });

  it('wraps the concurrent build in the migrator transaction boundaries', () => {
    const { sql } = readIndexMigration();

    // This repository's transactional migrator needs the concurrent statement
    // outside a transaction: COMMIT; immediately before, BEGIN; after.
    expect(sql.trimStart().startsWith('COMMIT;')).toBe(true);
    expect(sql.trimEnd().endsWith('BEGIN;')).toBe(true);
  });
});
