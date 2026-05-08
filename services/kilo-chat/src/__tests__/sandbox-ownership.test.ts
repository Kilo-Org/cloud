import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbState = vi.hoisted(() => ({
  rows: [] as { sandbox_id: string; user_id: string }[],
  queryCount: 0,
}));

vi.unmock('../services/sandbox-ownership');

vi.mock('@kilocode/db', () => ({
  getWorkerDb: () => ({
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async (limit: number) => {
            dbState.queryCount += 1;
            const rows =
              'sandbox_id' in selection
                ? dbState.rows.map(row => ({ sandbox_id: row.sandbox_id }))
                : dbState.rows.map(row => ({ user_id: row.user_id }));
            return rows.slice(0, limit);
          },
        }),
      }),
    }),
  }),
}));

const env = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
} as Env;

const { lookupSandboxOwnerUserId, userOwnsSandbox } = await import('../services/sandbox-ownership');

describe('sandbox ownership lookups', () => {
  beforeEach(() => {
    dbState.rows = [{ sandbox_id: 'sandbox-1', user_id: 'user-1' }];
    dbState.queryCount = 0;
  });

  it('does not reuse a positive ownership result after the instance is destroyed', async () => {
    await expect(userOwnsSandbox(env, 'user-1', 'sandbox-1')).resolves.toBe(true);

    dbState.rows = [];

    await expect(userOwnsSandbox(env, 'user-1', 'sandbox-1')).resolves.toBe(false);
    expect(dbState.queryCount).toBe(2);
  });

  it('does not reuse a positive owner lookup after the instance is destroyed', async () => {
    await expect(lookupSandboxOwnerUserId(env, 'sandbox-1')).resolves.toBe('user-1');

    dbState.rows = [];

    await expect(lookupSandboxOwnerUserId(env, 'sandbox-1')).resolves.toBeNull();
    expect(dbState.queryCount).toBe(2);
  });
});
