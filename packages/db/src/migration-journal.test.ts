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
   * alone. They are allowed, not required: the assertions are subset checks, so
   * repairing one of them later keeps the suite green, while any new gap or a
   * newly dangling `prevId` fails.
   */
  it('keeps every journal entry backed by a snapshot and every prevId resolvable', () => {
    const migrationsDir = path.join(__dirname, 'migrations');
    const metaDir = path.join(migrationsDir, 'meta');
    const rootPrevId = '00000000-0000-0000-0000-000000000000';
    const legacyGaps = new Set([21, 34, 72, 110, 303]);

    const journal = JSON.parse(fs.readFileSync(path.join(metaDir, '_journal.json'), 'utf-8')) as {
      entries: { idx: number; tag: string }[];
    };

    // A snapshot document is over a megabyte. Read each one, keep only the two
    // ids the chain needs, and let the parsed document go.
    const snapshotByIdx = new Map<number, { id: string; prevId: string }>();
    const missing: number[] = [];
    for (const entry of journal.entries) {
      const file = path.join(metaDir, `${entry.idx.toString().padStart(4, '0')}_snapshot.json`);
      if (!fs.existsSync(file)) {
        missing.push(entry.idx);
        continue;
      }
      const { id, prevId } = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        id: string;
        prevId: string;
      };
      snapshotByIdx.set(entry.idx, { id, prevId });
    }

    const ids = new Set([...snapshotByIdx.values()].map(snapshot => snapshot.id));
    const dangling: number[] = [];
    for (const [idx, snapshot] of snapshotByIdx) {
      if (snapshot.prevId === rootPrevId) continue;
      if (!ids.has(snapshot.prevId)) dangling.push(idx);
    }

    // Each legacy gap leaves the entry right after it prevId-ing a snapshot that
    // never existed. Every other unresolved `prevId` is new breakage.
    const allowedDangling = new Set(
      [...legacyGaps].map(gap => gap + 1).filter(idx => snapshotByIdx.has(idx))
    );

    expect(missing.filter(idx => !legacyGaps.has(idx))).toEqual([]);
    expect(dangling.filter(idx => !allowedDangling.has(idx))).toEqual([]);

    // Beyond the legacy gaps the chain must close exactly: prevId of each
    // snapshot is the id of the previous existing one. An entry right after a
    // legacy gap is exempt only while that gap is still unfilled — if someone
    // restores the snapshot later, its successor is held to the exact check too.
    const indexes = [...snapshotByIdx.keys()].sort((a, b) => a - b);
    for (let position = 1; position < indexes.length; position++) {
      const current = indexes[position];
      const previous = indexes[position - 1];
      if (current === undefined || previous === undefined) continue;
      if (legacyGaps.has(current - 1) && !snapshotByIdx.has(current - 1)) continue;
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
