import { describe, expect, it, vi } from 'vitest';
import type { getWorkerDb } from '@kilocode/db/client';

import { setSafeParentSessionId } from './session-parent';

type WorkerDb = ReturnType<typeof getWorkerDb>;

function makeParentDb() {
  const selectResult = vi.fn<() => Promise<Array<{ parent_session_id: string | null }>>>(
    async () => []
  );
  const select = {
    from: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      selectResult().then(resolve, reject)
    ),
  };

  const updateResult = vi.fn<() => Promise<Array<{ session_id: string }>>>(async () => []);
  const update = {
    set: vi.fn(() => update),
    where: vi.fn(() => update),
    returning: vi.fn(() => update),
    then: vi.fn((resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      updateResult().then(resolve, reject)
    ),
  };

  return {
    db: {
      select: vi.fn(() => select),
      update: vi.fn(() => update),
    } as unknown as WorkerDb,
    fns: {
      selectResult,
      updateResult,
      updateSet: update.set,
    },
  };
}

describe('setSafeParentSessionId', () => {
  it('retries until a shortly delayed same-user parent row can be linked', async () => {
    const { db, fns } = makeParentDb();
    fns.updateResult
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ session_id: 'ses_child123456789012345678901' }]);

    await expect(
      setSafeParentSessionId(
        db,
        'usr_test',
        'ses_child123456789012345678901',
        'ses_parent12345678901234567890',
        { attempts: 2, delayMs: 0 }
      )
    ).resolves.toBe(true);
    expect(fns.updateResult).toHaveBeenCalledTimes(2);
  });

  it('returns true without updating when the child is already linked', async () => {
    const { db, fns } = makeParentDb();
    fns.selectResult.mockResolvedValueOnce([
      { parent_session_id: 'ses_parent12345678901234567890' },
    ]);

    await expect(
      setSafeParentSessionId(
        db,
        'usr_test',
        'ses_child123456789012345678901',
        'ses_parent12345678901234567890',
        { attempts: 2, delayMs: 0 }
      )
    ).resolves.toBe(true);
    expect(fns.updateSet).not.toHaveBeenCalled();
  });

  it('rejects self-parenting without querying Postgres', async () => {
    const { db, fns } = makeParentDb();

    await expect(
      setSafeParentSessionId(
        db,
        'usr_test',
        'ses_12345678901234567890123456',
        'ses_12345678901234567890123456'
      )
    ).resolves.toBe(false);
    expect(fns.selectResult).not.toHaveBeenCalled();
    expect(fns.updateSet).not.toHaveBeenCalled();
  });

  it('treats concurrent parent deletion as a retryable miss', async () => {
    const { db, fns } = makeParentDb();
    fns.updateResult
      .mockRejectedValueOnce({ code: '23503' })
      .mockResolvedValueOnce([{ session_id: 'ses_child123456789012345678901' }]);

    await expect(
      setSafeParentSessionId(
        db,
        'usr_test',
        'ses_child123456789012345678901',
        'ses_parent12345678901234567890',
        { attempts: 2, delayMs: 0 }
      )
    ).resolves.toBe(true);
    expect(fns.updateResult).toHaveBeenCalledTimes(2);
  });

  it('does not swallow non-FK database errors', async () => {
    const { db, fns } = makeParentDb();
    const dbError = new Error('database unavailable');
    fns.updateResult.mockRejectedValueOnce(dbError);

    await expect(
      setSafeParentSessionId(
        db,
        'usr_test',
        'ses_child123456789012345678901',
        'ses_parent12345678901234567890',
        { attempts: 2, delayMs: 0 }
      )
    ).rejects.toBe(dbError);
  });
});
