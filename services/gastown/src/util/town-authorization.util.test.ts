import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.fn();

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({ select })) }));

import { authorizeTown } from './town-authorization.util';

const identity = {
  ownerType: 'org' as const,
  ownerUserId: 'owner',
  organizationId: 'org-1',
  runtimeMode: 'modern' as const,
};

function rows(...values: unknown[]) {
  let index = 0;
  select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(values[index++]) }),
      innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve(values[index++]) }) }),
    }),
  }));
}

describe('authorizeTown', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    [
      'stale admin',
      [[{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: false }], []],
    ],
    ['missing pepper', [[{ pepper: null, blockedAt: null, blockedReason: null, isAdmin: true }]]],
    [
      'blocked principal',
      [[{ pepper: 'pepper', blockedAt: '2026-01-01', blockedReason: null, isAdmin: true }]],
    ],
    [
      'null token pepper',
      [[{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: true }]],
    ],
  ])('rejects %s', async (_name, values) => {
    rows(...values);
    const result = await authorizeTown(
      { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
      identity,
      'user',
      _name === 'null token pepper' ? null : 'pepper'
    );
    expect(result).toBeNull();
  });

  it('allows a current active admin', async () => {
    rows([{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: true }]);
    await expect(
      authorizeTown(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        identity,
        'user',
        'pepper'
      )
    ).resolves.toEqual({ type: 'admin' });
  });

  it.each([
    ['removed member', []],
    ['cached billing manager role', [{ role: 'billing_manager' }]],
  ])('rejects %s', async (_name, membership) => {
    rows([{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: false }], membership);
    await expect(
      authorizeTown(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        identity,
        'user',
        'pepper'
      )
    ).resolves.toBeNull();
  });
});
