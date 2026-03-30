import { describe, expect, it, vi } from 'vitest';
import { deleteSessionTree } from './delete-session-tree';

function makeDbFakes() {
  const deleteChain = {
    where: vi.fn(() => deleteChain),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(undefined)),
  };

  const txDeleteFn = vi.fn(() => deleteChain);
  const tx = { delete: txDeleteFn };

  const executeResult = vi.fn(async () => ({ rows: [] as Array<{ session_id: string }> }));
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));

  const db = { execute: executeResult, transaction } as unknown as Parameters<
    typeof deleteSessionTree
  >[0];

  return { db, fns: { executeResult, transaction, txDeleteFn } };
}

describe('deleteSessionTree', () => {
  it('returns the target sessionId when CTE finds only the root', async () => {
    const { db, fns } = makeDbFakes();
    fns.executeResult.mockResolvedValueOnce({
      rows: [{ session_id: 'ses_12345678901234567890123456' }],
    });

    const result = await deleteSessionTree(db, 'ses_12345678901234567890123456', 'usr_1');

    expect(result).toEqual(['ses_12345678901234567890123456']);
    expect(fns.transaction).toHaveBeenCalledTimes(1);
    expect(fns.txDeleteFn).toHaveBeenCalledTimes(1);
  });

  it('falls back to target sessionId when CTE returns no rows', async () => {
    const { db, fns } = makeDbFakes();
    fns.executeResult.mockResolvedValueOnce({ rows: [] });

    const result = await deleteSessionTree(db, 'ses_12345678901234567890123456', 'usr_1');

    expect(result).toEqual(['ses_12345678901234567890123456']);
    expect(fns.transaction).toHaveBeenCalledTimes(1);
    expect(fns.txDeleteFn).toHaveBeenCalledTimes(1);
  });

  it('returns all session IDs depth-first when CTE finds a tree', async () => {
    const { db, fns } = makeDbFakes();
    fns.executeResult.mockResolvedValueOnce({
      rows: [
        { session_id: 'ses_grandchild0000000000000000' },
        { session_id: 'ses_child000000000000000000000' },
        { session_id: 'ses_parent00000000000000000000' },
      ],
    });

    const result = await deleteSessionTree(db, 'ses_parent00000000000000000000', 'usr_1');

    expect(result).toEqual([
      'ses_grandchild0000000000000000',
      'ses_child000000000000000000000',
      'ses_parent00000000000000000000',
    ]);
    expect(fns.transaction).toHaveBeenCalledTimes(1);
    expect(fns.txDeleteFn).toHaveBeenCalledTimes(3);
  });
});
