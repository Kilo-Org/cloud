jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: () => true,
}));
jest.mock('./store', () => ({ getGrantedClaudeBillingConnection: jest.fn() }));

import { afterEach, describe, expect, it } from '@jest/globals';
import { getGrantedClaudeBillingConnection } from './store';
import { getAuthoritativeClaudeBillingState } from './payer-state';
import { readJsonBody } from '@kilocode/web-shared/tests/helpers/request-body.helper';

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
            created_by: 'owner',
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          connection: {
            status: 'removed',
            user_profile_id: 'uprof_owner',
            connected_at: null,
            created_by: 'owner',
          },
        })
      );
    expect(await getAuthoritativeClaudeBillingState(owner)).toMatchObject({ status: 'connected' });
    expect(await getAuthoritativeClaudeBillingState(owner)).toMatchObject({ status: 'removed' });
    expect(getGrantedClaudeBillingConnection).not.toHaveBeenCalled();
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

  it('asks with the owner shape the previous web app release reads', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ connection: null }));
    const organizationId = '00000000-0000-4000-8000-000000000002';
    await getAuthoritativeClaudeBillingState({ kind: 'shared_services', organizationId });
    await getAuthoritativeClaudeBillingState({
      kind: 'member',
      kiloUserId: 'owner',
      organizationId,
    });
    expect(fetchMock.mock.calls.map(([, init]) => readJsonBody(init?.body))).toEqual([
      { kind: 'organization', organizationId },
      { kind: 'organization', organizationId, kiloUserId: 'owner' },
    ]);
  });

  it("does not take the organization's row for a member from the previous web app release", async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        connection: { status: 'connected', user_profile_id: 'uprof_org', connected_at: null },
      })
    );
    await expect(
      getAuthoritativeClaudeBillingState({
        kind: 'member',
        kiloUserId: 'owner',
        organizationId: '00000000-0000-4000-8000-000000000002',
      })
    ).resolves.toBeNull();
  });
});
