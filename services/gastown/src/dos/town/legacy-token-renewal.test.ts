import { jwtVerify } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';

const select = vi.fn();

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn(() => ({ select })) }));

import { isLegacyTownTokenRenewalAuthorized } from './legacy-token-renewal';

const env = { HYPERDRIVE: { connectionString: 'postgres://' } } as Env;
const personalIdentity = { ownerType: 'user' as const, ownerUserId: 'user-1' };
const orgIdentity = {
  ownerType: 'org' as const,
  ownerUserId: 'user-1',
  organizationId: 'org-1',
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

describe('isLegacyTownTokenRenewalAuthorized', () => {
  beforeEach(() => vi.resetAllMocks());

  it('allows a current personal owner with the current pepper', async () => {
    rows([{ pepper: 'current', blockedAt: null, blockedReason: null }]);

    await expect(
      isLegacyTownTokenRenewalAuthorized(env, personalIdentity, 'user-1', 'current')
    ).resolves.toBe(true);
  });

  it.each([
    ['rotated pepper', [{ pepper: 'new', blockedAt: null, blockedReason: null }]],
    ['null pepper', [{ pepper: null, blockedAt: null, blockedReason: null }]],
    ['blocked_at', [{ pepper: 'current', blockedAt: '2026-01-01', blockedReason: null }]],
    ['blocked_reason', [{ pepper: 'current', blockedAt: null, blockedReason: 'abuse' }]],
    ['missing user', []],
  ])('rejects a %s user', async (_name, user) => {
    rows(user);

    await expect(
      isLegacyTownTokenRenewalAuthorized(env, personalIdentity, 'user-1', 'current')
    ).resolves.toBe(false);
  });

  it('rejects a null token pepper even when the current user is unpeppered', async () => {
    rows([{ pepper: null, blockedAt: null, blockedReason: null }]);

    await expect(
      isLegacyTownTokenRenewalAuthorized(env, personalIdentity, 'user-1', null)
    ).resolves.toBe(false);
  });

  it('rejects an org token after membership is removed and re-added for another identity', async () => {
    rows([{ pepper: 'current', blockedAt: null, blockedReason: null }], [{ role: 'owner' }]);

    await expect(
      isLegacyTownTokenRenewalAuthorized(env, orgIdentity, 're-added-user', 'current')
    ).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    ['removed membership', []],
    ['billing manager membership', [{ role: 'billing_manager' }]],
  ])('rejects an org token with a %s', async (_name, membership) => {
    rows([{ pepper: 'current', blockedAt: null, blockedReason: null }], membership);

    await expect(
      isLegacyTownTokenRenewalAuthorized(env, orgIdentity, 'user-1', 'current')
    ).resolves.toBe(false);
  });

  it('allows a current eligible org member', async () => {
    rows([{ pepper: 'current', blockedAt: null, blockedReason: null }], [{ role: 'owner' }]);

    await expect(
      isLegacyTownTokenRenewalAuthorized(env, orgIdentity, 'user-1', 'current')
    ).resolves.toBe(true);
  });

  it('allows an expired but validly signed token when its current owner is authorized', async () => {
    const secret = 'test-secret';
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: 'current',
      secret,
      expiresInSeconds: -1,
    });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
      clockTolerance: 10 * 365 * 24 * 60 * 60,
    });
    rows([{ pepper: 'current', blockedAt: null, blockedReason: null }]);

    await expect(
      isLegacyTownTokenRenewalAuthorized(
        env,
        personalIdentity,
        payload.kiloUserId as string,
        payload.apiTokenPepper as string
      )
    ).resolves.toBe(true);
  });
});
