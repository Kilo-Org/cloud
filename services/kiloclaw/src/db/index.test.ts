import { describe, it, expect, vi } from 'vitest';
import { recordScheduledActionTargetOutcome } from './index';
import type { WorkerDb } from '@kilocode/db/client';

/**
 * Unit coverage for the deferred-resolution half of the cancel/claim
 * handoff (see the doc comment on recordScheduledActionTargetOutcome).
 * A target claimed by the DO's apply pass (pending -> running) is
 * untouched by the admin cancel mutation's own UPDATE, which only
 * touches 'pending' rows. When this function later resolves that
 * target's real outcome, it must queue the cancellation-notification
 * insert itself if the outcome isn't 'applied' — that's the exact
 * invariant under test here.
 *
 * No real Postgres connection: services/kiloclaw's `pnpm test` runs in
 * CI's workspace-tests matrix job, which has no Postgres service
 * container (unlike the root `test` job). A real-DB integration test
 * for this function would pass locally and fail in CI. Instead this
 * fakes the WorkerDb transaction surface just enough to observe the
 * control flow: does the notification INSERT (`tx.execute`) fire, and
 * how many times.
 *
 * The target/stage/parent UPDATE calls in the real function chain
 * `.update().set().where()` (and `.returning()` for the target row
 * only) — the fake chain below supports exactly that shape and nothing
 * more. It is not a drizzle behavior simulation; it only lets the real
 * function's branching logic run to completion so the `tx.execute`
 * call count reflects the real guard (`args.outcome !== 'applied'`).
 */
function makeFakeTx(opts: { claimed: boolean }) {
  const chain = {
    set: () => chain,
    where: () => chain,
    returning: async () => (opts.claimed ? [{ id: 'target-1' }] : []),
    then: (resolve: (value: undefined) => void) => resolve(undefined),
  };
  const execute = vi.fn(async () => ({ rows: [] }));
  const tx = {
    update: () => chain,
    execute,
  };
  return { tx, execute };
}

function makeFakeDb(tx: unknown): WorkerDb {
  return {
    transaction: async (cb: (tx: unknown) => Promise<void>) => cb(tx),
  } as unknown as WorkerDb;
}

describe('recordScheduledActionTargetOutcome', () => {
  const baseArgs = {
    target_id: 'target-1',
    scheduled_action_id: 'action-1',
    stage_id: 'stage-1',
  };

  it('does not queue a cancellation notification when the outcome is applied', async () => {
    const { tx, execute } = makeFakeTx({ claimed: true });
    const db = makeFakeDb(tx);

    await recordScheduledActionTargetOutcome(db, { ...baseArgs, outcome: 'applied' });

    expect(execute).not.toHaveBeenCalled();
  });

  it('queues a cancellation notification when a claimed target resolves skipped', async () => {
    const { tx, execute } = makeFakeTx({ claimed: true });
    const db = makeFakeDb(tx);

    await recordScheduledActionTargetOutcome(db, {
      ...baseArgs,
      outcome: 'skipped',
      skip_reason: 'pinned',
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('queues a cancellation notification when a claimed target resolves failed', async () => {
    const { tx, execute } = makeFakeTx({ claimed: true });
    const db = makeFakeDb(tx);

    await recordScheduledActionTargetOutcome(db, {
      ...baseArgs,
      outcome: 'failed',
      error_message: 'restart failed',
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the CAS misses (another pass already claimed the target)', async () => {
    const { tx, execute } = makeFakeTx({ claimed: false });
    const db = makeFakeDb(tx);

    await recordScheduledActionTargetOutcome(db, { ...baseArgs, outcome: 'skipped' });

    // The function returns early once `updated.length === 0` — the
    // notification insert (and the counter bumps) must not run.
    expect(execute).not.toHaveBeenCalled();
  });
});
