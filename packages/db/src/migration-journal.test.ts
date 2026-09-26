/**
 * The migration-journal guard reads generated files only: it needs no database,
 * so it lives in its own suite and runs wherever this package's tests run —
 * including the DB-less `workspace-tests` matrix. The DB-backed suites in
 * `schema.test.ts` connect to `POSTGRES_URL` and cannot run there.
 *
 * Drizzle applies a migration only when its `folderMillis` is newer than the
 * newest applied row, so a rebased branch that appends its migration with a
 * stale `when` is skipped forever on every database that already applied the
 * entry before it.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

describe('migration journal', () => {
  it('keeps a newly appended migration newer than every entry before it', () => {
    const journalPath = path.join(__dirname, 'migrations', 'meta', '_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const entries = journal.entries;

    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1];
      const current = entries[index];
      if (!previous || !current) throw new Error('journal entry missing');
      expect(current.idx).toBe(previous.idx + 1);
    }

    // New migrations are appended, so the tail must be newer than every earlier
    // entry. (0035 predates this guard and is re-created by 0038, so only the
    // appended tail is asserted here.)
    const last = entries.at(-1);
    if (!last) throw new Error('journal is empty');
    for (const entry of entries.slice(0, -1)) {
      expect(last.when).toBeGreaterThan(entry.when);
    }

    for (const entry of entries) {
      expect(fs.existsSync(path.join(__dirname, 'migrations', `${entry.tag}.sql`))).toBe(true);
    }
  });
});
