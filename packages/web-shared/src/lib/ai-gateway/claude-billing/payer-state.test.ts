jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: () => true,
}));
jest.mock('./store', () => ({ getClaudeBillingConnection: jest.fn() }));

import { afterEach, describe, expect, it } from '@jest/globals';
import { getClaudeBillingConnection } from './store';
import { getAuthoritativeClaudeBillingState } from './payer-state';

const owner = { kind: 'personal', kiloUserId: 'owner' } as const;
afterEach(() => {
  jest.restoreAllMocks();
});

describe('Cross-region Claude payer state', () => {
  it('observes the current primary state without a replica or an in-process state cache', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          connection: {
            status: 'connected',
            user_profile_id: 'uprof_owner',
            connected_at: '2026-01-01T00:00:00Z',
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          connection: { status: 'removed', user_profile_id: 'uprof_owner', connected_at: null },
        })
      );
    expect(await getAuthoritativeClaudeBillingState(owner)).toMatchObject({ status: 'connected' });
    expect(await getAuthoritativeClaudeBillingState(owner)).toMatchObject({ status: 'removed' });
    expect(getClaudeBillingConnection).not.toHaveBeenCalled();
  });

  it('keeps authoritative absence distinct from unavailable state', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ connection: null }));
    expect(await getAuthoritativeClaudeBillingState(owner)).toBeNull();
  });

  it.each([401, 503])(
    'does not treat a failed lookup as an absent connection (%s)',
    async status => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status }));
      await expect(getAuthoritativeClaudeBillingState(owner)).rejects.toThrow(
        'payer-state read failed'
      );
    }
  );

  it('rejects a malformed successful lookup instead of switching payer', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ connection: {} }));
    await expect(getAuthoritativeClaudeBillingState(owner)).rejects.toThrow();
  });
});
