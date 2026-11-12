import { describe, expect, it, vi } from 'vitest';

import { canCreateCliSessionForUser } from './user-session-admission';

describe('canCreateCliSessionForUser', () => {
  it.each([
    {
      name: 'unblocked user',
      rows: [{ blocked_at: null, blocked_reason: null }],
      expected: true,
    },
    {
      name: 'user with a blocked reason',
      rows: [{ blocked_at: null, blocked_reason: 'tos' }],
      expected: false,
    },
    {
      name: 'user with a block timestamp',
      rows: [{ blocked_at: '2026-01-15T12:00:00.000Z', blocked_reason: null }],
      expected: false,
    },
    { name: 'missing user', rows: [], expected: false },
  ])('returns $expected for a $name', async ({ rows, expected }) => {
    const forUpdate = vi.fn(async () => rows);
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      for: forUpdate,
    };
    const db = { select: vi.fn(() => query) };

    await expect(canCreateCliSessionForUser(db as never, 'usr_test')).resolves.toBe(expected);
    expect(forUpdate).toHaveBeenCalledWith('update');
  });
});
