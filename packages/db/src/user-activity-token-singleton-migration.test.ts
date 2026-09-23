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

describe('user_activity_tokens live ios_activity singleton migration', () => {
  const readLastTwoMigrations = () => {
    const migrationsDir = path.join(__dirname, 'migrations');
    const journal = JSON.parse(
      fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf-8')
    ) as { entries: { idx: number; tag: string }[] };

    const later = journal.entries.at(-1);
    const earlier = journal.entries.at(-2);
    if (!earlier || !later) throw new Error('journal needs at least two entries');

    const read = (tag: string) => fs.readFileSync(path.join(migrationsDir, `${tag}.sql`), 'utf-8');
    return {
      earlier: { tag: earlier.tag, sql: read(earlier.tag) },
      later: { tag: later.tag, sql: read(later.tag) },
    };
  };

  it('adds the column and dedupes live rows before creating the partial unique index', () => {
    const { earlier, later } = readLastTwoMigrations();

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
});
