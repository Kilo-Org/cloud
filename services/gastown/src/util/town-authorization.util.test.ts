import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.fn();

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({ select })) }));

import {
  authorizeOrganization,
  authorizeTown,
  TownAuthorizationUnavailableError,
} from './town-authorization.util';

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
    rows([{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: true }], []);
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
    ['owner', 'user'],
    ['other-admin', 'admin'],
  ])('preserves personal ownership before admin fallback for %s', async (userId, type) => {
    rows([{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: true }]);
    await expect(
      authorizeTown(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        { ...identity, ownerType: 'user', organizationId: undefined },
        userId,
        'pepper'
      )
    ).resolves.toEqual({ type });
  });

  it.each([
    ['owner', { type: 'org', organizationId: 'org-1', role: 'owner' }],
    ['member', { type: 'org', organizationId: 'org-1', role: 'member' }],
    ['billing_manager', { type: 'admin' }],
    [null, { type: 'admin' }],
  ])('preserves current org role %j before admin inspection fallback', async (role, expected) => {
    rows(
      [{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: true }],
      role ? [{ role }] : []
    );
    await expect(
      authorizeTown(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        identity,
        'user',
        'pepper'
      )
    ).resolves.toEqual(expected);
  });

  it('reports a personal-town authority database failure as unavailable', async () => {
    select.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    await expect(
      authorizeTown(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        { ...identity, ownerType: 'user', organizationId: undefined },
        'user',
        'pepper'
      )
    ).rejects.toBeInstanceOf(TownAuthorizationUnavailableError);
  });

  it('uses one principal query and one membership query for a non-admin org member', async () => {
    rows(
      [{ pepper: 'pepper', blockedAt: null, blockedReason: null, isAdmin: false }],
      [{ role: 'member' }]
    );
    await expect(
      authorizeTown(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        identity,
        'user',
        'pepper'
      )
    ).resolves.toEqual({ type: 'org', organizationId: 'org-1', role: 'member' });
    expect(select).toHaveBeenCalledTimes(2);
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

describe('authorizeOrganization', () => {
  it.each([
    ['removed member', [{ pepper: 'pepper', blockedAt: null, blockedReason: null }], []],
    [
      'demoted member',
      [{ pepper: 'pepper', blockedAt: null, blockedReason: null }],
      [{ role: 'billing_manager' }],
    ],
    ['missing pepper', [{ pepper: null, blockedAt: null, blockedReason: null }], []],
    ['mismatched pepper', [{ pepper: 'other', blockedAt: null, blockedReason: null }], []],
    ['blocked user', [{ pepper: 'pepper', blockedAt: '2026-01-01', blockedReason: null }], []],
    ['deleted organization', [{ pepper: 'pepper', blockedAt: null, blockedReason: null }], []],
  ])('rejects a %s', async (_name, principal, membership) => {
    rows(principal, membership);
    await expect(
      authorizeOrganization(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        'org-1',
        'user',
        'pepper'
      )
    ).resolves.toBeNull();
  });

  it('returns the current membership role', async () => {
    rows([{ pepper: 'pepper', blockedAt: null, blockedReason: null }], [{ role: 'member' }]);
    await expect(
      authorizeOrganization(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        'org-1',
        'user',
        'pepper'
      )
    ).resolves.toEqual({ role: 'member' });
  });

  it('reports an authority database failure as unavailable', async () => {
    select.mockImplementation(() => {
      throw new Error('database unavailable');
    });
    await expect(
      authorizeOrganization(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        'org-1',
        'user',
        'pepper'
      )
    ).rejects.toBeInstanceOf(TownAuthorizationUnavailableError);
  });
});

describe('current null-pepper organization authority', () => {
  it.each([
    [null, null, true],
    [null, 'rotated', false],
    ['old', null, false],
    [undefined, null, false],
    [undefined, undefined, false],
    ['', '', false],
    [null, undefined, false],
  ])('token %j against current DB %j', async (tokenPepper, pepper, allowed) => {
    rows([{ pepper, blockedAt: null, blockedReason: null }], [{ role: 'member' }]);
    await expect(
      authorizeOrganization(
        { HYPERDRIVE: { connectionString: 'postgres://' } } as Env,
        'org-1',
        'oauth/user',
        tokenPepper as string | null
      )
    ).resolves.toEqual(allowed ? { role: 'member' } : null);
  });
});
