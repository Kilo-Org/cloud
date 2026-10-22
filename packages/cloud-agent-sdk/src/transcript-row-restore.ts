import type { WritableAtom } from 'jotai';
import type { JotaiStore } from './storage/jotai';
import type { CachedSessionSnapshotPage, PreparationAttempt, SessionCommit } from './types';

type RowsAtom<Row> = WritableAtom<readonly Row[], [readonly Row[]], void>;

type TranscriptRowRestore = {
  /** Paints a page's rows unless live rows are on screen. A later page replaces restored rows. */
  restore(page: Pick<CachedSessionSnapshotPage, 'preparationAttempts' | 'commits'>): void;
  /** Applies the live rows. An empty live list keeps restored rows until its replay lands. */
  applyLive(
    preparationAttempts: readonly PreparationAttempt[],
    commits: readonly SessionCommit[]
  ): void;
  reset(): void;
};

/**
 * Service-state rows (preparation attempts, commits) that a transcript page
 * paints before the stream replays them. A new live state starts empty, so an
 * empty live list must not remove rows from under the reader.
 */
export function createTranscriptRowRestore(
  store: JotaiStore,
  atoms: { preparationAttempts: RowsAtom<PreparationAttempt>; commits: RowsAtom<SessionCommit> }
): TranscriptRowRestore {
  const preparationAttempts = createRestorableRows(store, atoms.preparationAttempts);
  const commits = createRestorableRows(store, atoms.commits);
  return {
    restore(page) {
      preparationAttempts.restore(page.preparationAttempts);
      commits.restore(page.commits);
    },
    applyLive(liveAttempts, liveCommits) {
      preparationAttempts.applyLive(liveAttempts);
      commits.applyLive(liveCommits);
    },
    reset() {
      preparationAttempts.reset();
      commits.reset();
    },
  };
}

function createRestorableRows<Row>(store: JotaiStore, rowsAtom: RowsAtom<Row>) {
  let restored = false;
  return {
    restore(rows: readonly Row[] | undefined): void {
      if (!rows?.length || (!restored && store.get(rowsAtom).length > 0)) return;
      restored = true;
      store.set(rowsAtom, rows);
    },
    applyLive(rows: readonly Row[]): void {
      if (rows.length === 0 && restored) return;
      restored = false;
      store.set(rowsAtom, rows);
    },
    reset(): void {
      restored = false;
    },
  };
}
