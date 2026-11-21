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

  /**
   * `drizzle-kit check` only looks for id collisions and `generate` diffs against
   * the newest snapshot alone, so both miss a broken chain in the middle. A
   * merge resolution once renamed a snapshot away (#11124), leaving journal idx
   * 361 with no snapshot and making 0362's `prevId` dangle; every check stayed
   * green because the latest snapshot was intact.
   *
   * The five gaps listed below predate this guard (2026-04..08) and are left
   * alone. The assertion is exact rather than permissive: the observed sets must
   * equal these, so a *new* gap or a new dangling `prevId` fails the suite.
   */
  it('keeps every journal entry backed by a snapshot and every prevId resolvable', () => {
    const migrationsDir = path.join(__dirname, 'migrations');
    const metaDir = path.join(migrationsDir, 'meta');
    const rootPrevId = '00000000-0000-0000-0000-000000000000';
    const legacyGaps = new Set([21, 34, 72, 110, 303]);

    const journal = JSON.parse(fs.readFileSync(path.join(metaDir, '_journal.json'), 'utf-8')) as {
      entries: { idx: number; tag: string }[];
    };

    const snapshotByIdx = new Map<number, { id: string; prevId: string }>();
    const missing: number[] = [];
    for (const entry of journal.entries) {
      const name = `${entry.idx.toString().padStart(4, '0')}_snapshot.json`;
      const file = path.join(metaDir, name);
      if (!fs.existsSync(file)) {
        missing.push(entry.idx);
        continue;
      }
      snapshotByIdx.set(
        entry.idx,
        JSON.parse(fs.readFileSync(file, 'utf-8')) as {
          id: string;
          prevId: string;
        }
      );
    }

    const ids = new Set([...snapshotByIdx.values()].map(snapshot => snapshot.id));
    const dangling: number[] = [];
    for (const [idx, snapshot] of snapshotByIdx) {
      if (snapshot.prevId === rootPrevId) continue;
      if (!ids.has(snapshot.prevId)) dangling.push(idx);
    }

    const expectedDangling = [...legacyGaps]
      .map(gap => gap + 1)
      .filter(idx => snapshotByIdx.has(idx));
    const sortedMissing = [...missing].sort((a, b) => a - b);
    const sortedDangling = [...dangling].sort((a, b) => a - b);

    expect(sortedMissing).toEqual([...legacyGaps].sort((a, b) => a - b));
    expect(sortedDangling).toEqual(expectedDangling.sort((a, b) => a - b));

    // Beyond the legacy gaps the chain must close exactly: prevId of each
    // snapshot is the id of the previous existing one. The entry right after a
    // legacy gap is excluded — its prevId names the snapshot that never
    // existed, which is exactly why it is reported as dangling above.
    const indexes = [...snapshotByIdx.keys()].sort((a, b) => a - b);
    for (let position = 1; position < indexes.length; position++) {
      const current = indexes[position];
      const previous = indexes[position - 1];
      if (current === undefined || previous === undefined) continue;
      if (legacyGaps.has(current - 1)) continue;
      const currentSnapshot = snapshotByIdx.get(current);
      const previousSnapshot = snapshotByIdx.get(previous);
      if (!currentSnapshot || !previousSnapshot) continue;
      expect({ idx: current, prevId: currentSnapshot.prevId }).toEqual({
        idx: current,
        prevId: previousSnapshot.id,
      });
    }
  });
});
