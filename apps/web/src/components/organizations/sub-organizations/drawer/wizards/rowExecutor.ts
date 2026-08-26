import { useCallback, useState } from 'react';

export type RowOutcome =
  | { status: 'pending' }
  | { status: 'running' }
  | { status: 'succeeded' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; reason: string };

/**
 * Runs `execute` for each of `rows[index]` at `indices`, strictly
 * sequentially — awaiting each call before starting the next — and reports
 * every state transition through `onUpdate`. Sequential (not
 * `Promise.all`/`Promise.allSettled`) is required here: `organizations.
 * members.invite` reads remaining seat capacity and writes a new row in the
 * same request, so concurrent invites near the seat limit could each read
 * the same "capacity available" snapshot and over-commit seats. Sequential
 * calls reproduce exactly what happens when an admin clicks "Invite"
 * multiple times in the existing dialog.
 *
 * A rejected `execute` call is recorded as `failed` and does not stop the
 * loop — subsequent rows still run. Pulled out as a plain async function
 * (no React) so the state-machine behavior — per-row transitions, a failure
 * not blocking later rows — can be unit tested with mocked promises without
 * rendering anything.
 */
export async function executeRows<TRow>(
  rows: TRow[],
  indices: number[],
  execute: (row: TRow) => Promise<void>,
  onUpdate: (index: number, outcome: RowOutcome) => void
): Promise<void> {
  for (const index of indices) {
    onUpdate(index, { status: 'running' });
    try {
      await execute(rows[index]);
      onUpdate(index, { status: 'succeeded' });
    } catch (error) {
      onUpdate(index, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Something went wrong',
      });
    }
  }
}

/**
 * React state wrapper around `executeRows`. `rows` and `skip` are read once,
 * at mount, to seed initial outcomes — callers should mount a fresh instance
 * of whatever component uses this hook per wizard "results" step rather than
 * changing `rows` in place.
 */
export function useRowExecutor<TRow>(
  rows: TRow[],
  skip: (row: TRow) => string | null,
  execute: (row: TRow) => Promise<void>
): {
  outcomes: RowOutcome[];
  isRunning: boolean;
  progress: { completed: number; total: number };
  start: () => void;
  retryFailed: () => void;
} {
  const [outcomes, setOutcomes] = useState<RowOutcome[]>(() =>
    rows.map(row => {
      const reason = skip(row);
      return reason ? ({ status: 'skipped', reason } as const) : ({ status: 'pending' } as const);
    })
  );
  const [isRunning, setIsRunning] = useState(false);

  const runIndices = useCallback(
    async (indices: number[]) => {
      if (indices.length === 0) return;
      setIsRunning(true);
      try {
        await executeRows(rows, indices, execute, (index, outcome) => {
          setOutcomes(previous =>
            previous.map((existing, i) => (i === index ? outcome : existing))
          );
        });
      } finally {
        setIsRunning(false);
      }
    },
    [rows, execute]
  );

  const start = useCallback(() => {
    void runIndices(
      outcomes.flatMap((outcome, index) => (outcome.status === 'pending' ? [index] : []))
    );
  }, [outcomes, runIndices]);

  const retryFailed = useCallback(() => {
    void runIndices(
      outcomes.flatMap((outcome, index) => (outcome.status === 'failed' ? [index] : []))
    );
  }, [outcomes, runIndices]);

  // A `skipped` row is resolved at mount and never runs, so it must count
  // as completed too — otherwise `progress.completed` can never reach
  // `progress.total` whenever any row is skipped, and the results view
  // gets stuck showing "queued" instead of the finished summary.
  const completed = outcomes.filter(
    outcome =>
      outcome.status === 'succeeded' || outcome.status === 'failed' || outcome.status === 'skipped'
  ).length;

  return {
    outcomes,
    isRunning,
    progress: { completed, total: rows.length },
    start,
    retryFailed,
  };
}
