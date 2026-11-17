jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/drizzle'),
  isUSRegion: () => true,
}));
jest.mock('./store', () => ({ getGrantedClaudeBillingConnection: jest.fn() }));

import { afterEach, describe, expect, it } from '@jest/globals';
import { getGrantedClaudeBillingConnection } from './store';
import { getAuthoritativeClaudeBillingState } from './payer-state';
import { readJsonBody } from '@kilocode/web-shared/tests/helpers/request-body.helper';

// A test that needs a different APP_URL loads the module again under
// jest.resetModules() with a doMock factory, because the static import above is
// bound to the real constants module.
const withOverriddenAppUrl = async (
  run: (
    load: () => Promise<{
      getAuthoritativeClaudeBillingState: typeof getAuthoritativeClaudeBillingState;
    }>
  ) => Promise<void>
): Promise<void> => {
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/constants', () => ({
    ...jest.requireActual<object>('@kilocode/web-shared/lib/constants'),
    APP_URL: 'http://app.example.com',
  }));
  try {
    await run(() => import('./payer-state'));
  } finally {
    jest.dontMock('@kilocode/web-shared/lib/constants');
    jest.resetModules();
  }
};

const owner = { kind: 'personal', kiloUserId: 'owner' } as const;
const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ORGANIZATION_ID = '00000000-0000-4000-8000-000000000003';
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
            kilo_user_id: 'owner',
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
            kilo_user_id: 'owner',
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

  it('asks with the owner shape the web app reads', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ connection: null }));
    await getAuthoritativeClaudeBillingState(owner);
    await getAuthoritativeClaudeBillingState({
      kind: 'organization',
      organizationId: ORGANIZATION_ID,
    });
    expect(fetchMock.mock.calls.map(([, init]) => readJsonBody(init?.body))).toEqual([
      { kind: 'personal', kiloUserId: 'owner' },
      { kind: 'organization', organizationId: ORGANIZATION_ID },
    ]);
  });

  it('returns a personal row that names its owner and no organization', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        connection: {
          status: 'connected',
          user_profile_id: 'uprof_owner',
          connected_at: null,
          kilo_user_id: 'owner',
          organization_id: null,
        },
      })
    );
    await expect(getAuthoritativeClaudeBillingState(owner)).resolves.toMatchObject({
      user_profile_id: 'uprof_owner',
    });
  });

  it.each([
    ['another person', { kilo_user_id: 'other-person' }],
    ['no person', {}],
    ['a null person', { kilo_user_id: null }],
    ['an organization', { kilo_user_id: 'owner', organization_id: OTHER_ORGANIZATION_ID }],
  ])(
    'requires a personal row to name its owner and no organization, given %s',
    async (_label, identity) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          connection: {
            status: 'connected',
            user_profile_id: 'uprof_owner',
            connected_at: null,
            ...identity,
          },
        })
      );
      await expect(getAuthoritativeClaudeBillingState(owner)).resolves.toBeNull();
    }
  );

  it('returns an organization row that names the requested organization', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        connection: {
          status: 'connected',
          user_profile_id: 'uprof_org',
          connected_at: null,
          kilo_user_id: null,
          organization_id: ORGANIZATION_ID,
        },
      })
    );
    await expect(
      getAuthoritativeClaudeBillingState({
        kind: 'organization',
        organizationId: ORGANIZATION_ID,
      })
    ).resolves.toMatchObject({ user_profile_id: 'uprof_org' });
  });

  it('returns an organization row when the requested organization differs only in case', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        connection: {
          status: 'connected',
          user_profile_id: 'uprof_org',
          connected_at: null,
          kilo_user_id: null,
          organization_id: ORGANIZATION_ID,
        },
      })
    );
    await expect(
      getAuthoritativeClaudeBillingState({
        kind: 'organization',
        organizationId: ORGANIZATION_ID.toUpperCase(),
      })
    ).resolves.toMatchObject({ user_profile_id: 'uprof_org' });
  });

  it.each([
    ['another organization', { organization_id: OTHER_ORGANIZATION_ID }],
    ['no organization', {}],
    ['a person', { kilo_user_id: 'owner', organization_id: ORGANIZATION_ID }],
  ])(
    'requires an organization row to name the requested organization and no person, given %s',
    async (_label, identity) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          connection: {
            status: 'connected',
            user_profile_id: 'uprof_org',
            connected_at: null,
            ...identity,
          },
        })
      );
      await expect(
        getAuthoritativeClaudeBillingState({
          kind: 'organization',
          organizationId: ORGANIZATION_ID,
        })
      ).resolves.toBeNull();
    }
  );

  it('requires an https or loopback app endpoint', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await withOverriddenAppUrl(async load => {
      const { getAuthoritativeClaudeBillingState: loadState } = await load();
      await expect(loadState(owner)).rejects.toThrow(
        'Claude payer-state endpoint is not configured'
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
