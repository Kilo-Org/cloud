/**
 * The live-iOS-activity singleton is enforced by a partial unique index that
 * cannot be created while duplicate live rows exist, so the dedupe backfill
 * must land in the migration immediately before it. This guard reads generated
 * files only — like `migration-journal.test.ts` — so it needs no database and
 * runs in the DB-less `workspace-tests` matrix. It turns that ordering into a
 * check instead of a convention.
 */
import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// Locate the pair by tag, not by journal position: the guard must keep holding
// after any unrelated migration is appended after it. The tags carry a
// generated numeric prefix, so match the stable descriptive suffix.
const COLUMN_MIGRATION_TAG = 'add_superseded_at_to_user_activity_tokens';
const INDEX_MIGRATION_TAG = 'user_activity_tokens_live_ios_activity_unique';

type JournalEntry = { idx: number; tag: string };

function locateMigrationPair(entries: JournalEntry[]): {
  earlier: JournalEntry;
  later: JournalEntry;
} {
  const earlier = entries.find(entry => entry.tag.endsWith(COLUMN_MIGRATION_TAG));
  const later = entries.find(entry => entry.tag.endsWith(INDEX_MIGRATION_TAG));
  if (!earlier || !later) {
    throw new Error(`journal is missing ${COLUMN_MIGRATION_TAG} or ${INDEX_MIGRATION_TAG}`);
  }
  // The dedupe must still land immediately before the index: an index build
  // over duplicate live rows fails.
  if (later.idx !== earlier.idx + 1) {
    throw new Error(
      `${later.tag} (idx ${later.idx}) must immediately follow ${earlier.tag} (idx ${earlier.idx})`
    );
  }
  return { earlier, later };
}

describe('user_activity_tokens live ios_activity singleton migration', () => {
  const readMigrationPair = () => {
    const migrationsDir = path.join(__dirname, 'migrations');
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf-8')
    ) as { entries: JournalEntry[] };

    const { earlier, later } = locateMigrationPair(journal.entries);
    const read = (tag: string) => fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf-8');
    return {
      earlier: { tag: earlier.tag, sql: read(earlier.tag) },
      later: { tag: later.tag, sql: read(later.tag) },
    };
  };

  it('adds the column and dedupes live rows before creating the partial unique index', () => {
    const { earlier, later } = readMigrationPair();

    // Migration A: the column and the self-heal seed.
    expect(earlier.sql).toContain('ADD COLUMN "superseded_at"');
    expect(earlier.sql).toContain('UPDATE "user_activity_tokens"');
    expect(earlier.sql).toContain('SET "superseded_at"');
    expect(earlier.sql).toContain('"superseded_at" IS NULL');
    // The index cannot exist yet — it is migration B's job.
    expect(earlier.sql).not.toContain('UQ_user_activity_tokens_live_ios_activity');

    // Migration B: the partial unique index, keyed on the coalesced scope so the
    // personal surface (null organization) is covered too.
    expect(later.sql).toContain('CREATE UNIQUE INDEX');
    expect(later.sql).toContain('"UQ_user_activity_tokens_live_ios_activity"');
    expect(later.sql).toContain('coalesce("organization_id", \'\')');
    expect(later.sql).toContain('"superseded_at" IS NULL');
    expect(later.sql).toContain("'ios_activity'");
    // A plain build on a populated table blocks writes for its duration, so the
    // index must be CONCURRENTLY, wrapped in the COMMIT;/BEGIN; boundaries this
    // repository's transactional migrator needs around a concurrent statement.
    expect(later.sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(later.sql.trimStart().startsWith('COMMIT;')).toBe(true);
    expect(later.sql.trimEnd().endsWith('BEGIN;')).toBe(true);
  });

  it('locates the pair by tag after an unrelated migration is appended', () => {
    const entries: JournalEntry[] = [
      { idx: 254, tag: '0254_charming_iron_patriot' },
      { idx: 255, tag: '0255_add_superseded_at_to_user_activity_tokens' },
      { idx: 256, tag: '0256_user_activity_tokens_live_ios_activity_unique' },
      { idx: 257, tag: '0257_next_migration' },
    ];

    expect(locateMigrationPair(entries)).toEqual({
      earlier: { idx: 255, tag: '0255_add_superseded_at_to_user_activity_tokens' },
      later: { idx: 256, tag: '0256_user_activity_tokens_live_ios_activity_unique' },
    });
  });

  it('rejects a pair that is not adjacent in the journal', () => {
    const entries: JournalEntry[] = [
      { idx: 255, tag: '0255_add_superseded_at_to_user_activity_tokens' },
      { idx: 256, tag: '0256_some_other_migration' },
      { idx: 257, tag: '0257_user_activity_tokens_live_ios_activity_unique' },
    ];

    expect(() => locateMigrationPair(entries)).toThrow(/must immediately follow/);
  });
});
