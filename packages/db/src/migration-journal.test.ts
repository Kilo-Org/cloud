/**
 * The migration-metadata guard reads generated files only: it needs no
 * database, so it lives in its own suite and runs wherever this package's tests
 * run — including the DB-less `workspace-tests` matrix. The DB-backed suites in
 * `schema.test.ts` connect to `POSTGRES_URL` and cannot run there.
 *
 * Drizzle applies a migration only when its `folderMillis` is newer than the
 * newest applied row, so a rebased branch that appends its migration with a
 * stale `when` is skipped forever on every database that already applied the
 * entry before it.
 *
 * Drizzle names a migration and its snapshot from the journal `idx`
 * (`<idx>_snapshot.json`) and diffs the schema against the newest snapshot file
 * in `meta/`. A renumbered tag or a hand-reverted snapshot therefore makes
 * `drizzle generate` diff against the wrong state and emit DDL that an earlier
 * migration already applied — for example a `DROP TABLE
 * "repository_customizations" CASCADE` for a table an earlier migration had
 * dropped.
 */
import { describe, expect, it } from '@jest/globals';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as fs from 'fs';
import * as path from 'path';
import * as schema from './schema';

type Journal = {
  entries: { idx: number; when: number; tag: string }[];
};

const migrationsDir = path.join(__dirname, 'migrations');
const migrationsMetaDir = path.join(migrationsDir, 'meta');

function readJournal(): Journal {
  const journalPath = path.join(migrationsMetaDir, '_journal.json');
  return JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as Journal;
}

/** The snapshots the generator sees, in the order it sorts them. */
function readSnapshotNames(): string[] {
  return fs
    .readdirSync(migrationsMetaDir)
    .filter(name => name.endsWith('_snapshot.json'))
    .sort();
}

describe('migration metadata', () => {
  it('keeps a newly appended migration newer than every entry before it', () => {
    const entries = readJournal().entries;

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
      expect(fs.existsSync(path.join(migrationsDir, `${entry.tag}.sql`))).toBe(true);
    }
  });

  it('keeps the Live Activity tail tags aligned with their journal idx', () => {
    const entries = readJournal().entries;
    // A rebase that rewrites an applied tag's prefix (0256_* → 0255_*, 0257_* →
    // 0256_*) leaves two journal entries sharing a number and a tag that no
    // longer matches its idx. The historical 0250_/0251_ duplicates predate
    // this guard; the Live Activity tail must keep prefix == idx.
    for (const entry of entries.slice(-2)) {
      expect(entry.tag.startsWith(`${entry.idx.toString().padStart(4, '0')}_`)).toBe(true);
    }
  });

  it('keeps the Live Activity tags at the prefixes main shipped', () => {
    const entries = readJournal().entries;
    // Locate by suffix so an unrelated later migration does not hide a rebase
    // that rewrote 0256_* → 0255_* and 0257_* → 0256_*.
    const column = entries.find(entry =>
      entry.tag.endsWith('add_superseded_at_to_user_activity_tokens')
    );
    const index = entries.find(entry =>
      entry.tag.endsWith('user_activity_tokens_live_ios_activity_unique')
    );
    expect(column?.tag).toBe('0256_add_superseded_at_to_user_activity_tokens');
    expect(index?.tag).toBe('0257_user_activity_tokens_live_ios_activity_unique');
  });

  it('keeps the newest snapshot file named for the last journal idx', () => {
    const last = readJournal().entries.at(-1);
    if (!last) throw new Error('journal is empty');

    const latestSnapshotName = readSnapshotNames().at(-1);
    if (!latestSnapshotName) throw new Error('no snapshot found in migrations/meta');

    // The generator diffs the schema against the newest snapshot it finds, not
    // against the journal's last entry, so a renumbered journal whose snapshot
    // was deleted would silently diff against an already-applied state.
    expect(latestSnapshotName).toBe(`${last.idx.toString().padStart(4, '0')}_snapshot.json`);
  });

  it('keeps a dropped table out of the newest snapshot', () => {
    const latestSnapshotName = readSnapshotNames().at(-1);
    if (!latestSnapshotName) throw new Error('no snapshot found in migrations/meta');

    const latestSnapshot = JSON.parse(
      fs.readFileSync(path.join(migrationsMetaDir, latestSnapshotName), 'utf-8')
    ) as { tables?: Record<string, unknown> };

    // 0255_drop_repository_customizations drops this table. A newest snapshot
    // that still carries it makes `drizzle generate` re-emit the destructive
    // `DROP TABLE "repository_customizations" CASCADE`.
    expect(Object.keys(latestSnapshot.tables ?? {})).not.toContain(
      'public.repository_customizations'
    );
  });

  it('does not emit already-applied DDL from the newest snapshot', async () => {
    const latestSnapshotName = readSnapshotNames().at(-1);
    if (!latestSnapshotName) throw new Error('no snapshot found in migrations/meta');

    const latestSnapshotPath = path.join(migrationsMetaDir, latestSnapshotName);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- drizzle-kit API types
    const latestSnapshot: Parameters<typeof generateMigration>[0] & { id: string } = JSON.parse(
      fs.readFileSync(latestSnapshotPath, 'utf-8')
    );

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access -- drizzle-kit API types
    const currentSchema = generateDrizzleJson(schema, latestSnapshot.id);

    const statements = await generateMigration(latestSnapshot, currentSchema);
    expect(statements).toEqual([]);
  });
});
