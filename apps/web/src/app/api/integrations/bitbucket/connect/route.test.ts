import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

jest.mock('@/lib/config.server', () => ({
  BITBUCKET_CLIENT_ID: 'bitbucket-client-id',
  NEXTAUTH_SECRET: 'test-nextauth-secret',
}));
jest.mock('@/lib/user/server');
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORGANIZATION_ID = '7e3011af-e99d-444f-8171-54c2225b87dc';

async function callPublicBitbucketConnect() {
  const { GET } = await import('../../[platform]/connect/route');
  return GET(
    new NextRequest(
      `http://localhost:3000/api/integrations/bitbucket/connect?organizationId=${ORGANIZATION_ID}&returnTo=%2Forganizations%2F${ORGANIZATION_ID}%2Fintegrations%2Fbitbucket`
    ),
    {
      params: Promise.resolve({ platform: 'bitbucket' }),
    }
  );
}

describe('GET /api/integrations/bitbucket/connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedEnsureOrganizationAccess.mockResolvedValue('owner');
  });

  test('dispatches the public OAuth route with organization ownership and required scopes', async () => {
    const response = await callPublicBitbucketConnect();

    expect(response.status).toBe(307);
    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(`${url.origin}${url.pathname}`).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      expect.objectContaining({
        client_id: 'bitbucket-client-id',
        response_type: 'code',
        scope: 'account repository:write pullrequest webhook',
      })
    );
    expect(verifyOAuthState(url.searchParams.get('state'))).toEqual({
      owner: `org_${ORGANIZATION_ID}`,
      userId: USER_ID,
      returnTo: `/organizations/${ORGANIZATION_ID}/integrations/bitbucket`,
    });
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      ORGANIZATION_ID,
      ['owner', 'billing_manager']
    );
  });
});
