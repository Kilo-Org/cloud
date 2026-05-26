import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { getLinearOAuthUrl } from '@/lib/integrations/linear-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';

jest.mock('@/lib/user/server');
jest.mock('@/lib/integrations/linear-service', () => ({
  getLinearOAuthUrl: jest.fn(),
}));
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: jest.fn(),
}));
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireActiveSubscriptionOrTrial: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetLinearOAuthUrl = jest.mocked(getLinearOAuthUrl);
const mockedEnsureOrganizationAccess = jest.mocked(ensureOrganizationAccess);
const mockedRequireActiveSubscriptionOrTrial = jest.mocked(requireActiveSubscriptionOrTrial);
const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

async function callLinearConnect(request: NextRequest) {
  const { GET } = await import('../../[platform]/connect/route');
  return GET(request, { params: Promise.resolve({ platform: 'linear' }) });
}

describe('GET /api/integrations/linear/connect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedGetLinearOAuthUrl.mockReturnValue('https://linear.app/oauth/authorize?state=signed');
    mockedEnsureOrganizationAccess.mockResolvedValue('owner');
    mockedRequireActiveSubscriptionOrTrial.mockResolvedValue({
      isReadOnly: false,
      daysRemaining: 30,
    });
  });

  test('redirects unauthenticated users to sign in with the connect URL as the callback', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(null, { status: 401 }),
    } as never);

    const response = await callLinearConnect(
      makeRequest('/api/integrations/linear/connect?organizationId=org-linear-123')
    );

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(url.pathname).toBe('/users/sign_in');
    expect(url.searchParams.get('callbackPath')).toBe(
      '/api/integrations/linear/connect?organizationId=org-linear-123'
    );
    expect(mockedGetLinearOAuthUrl).not.toHaveBeenCalled();
  });

  test('preserves a valid returnTo in signed OAuth state', async () => {
    await callLinearConnect(
      makeRequest('/api/integrations/linear/connect?returnTo=%2Fclaw%2Fnew%3Fstep%3Dlinear')
    );

    const state = mockedGetLinearOAuthUrl.mock.calls[0]?.[0];
    expect(verifyOAuthState(state ?? null)).toEqual(
      expect.objectContaining({
        owner: `user_${USER_ID}`,
        userId: USER_ID,
        returnTo: '/claw/new?step=linear',
      })
    );
  });

  test('authorizes org-scoped installs for owners and billing managers with an active subscription', async () => {
    await callLinearConnect(
      makeRequest('/api/integrations/linear/connect?organizationId=org-linear-123')
    );

    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: expect.objectContaining({ id: USER_ID }) },
      'org-linear-123',
      ['owner', 'billing_manager']
    );
    expect(mockedRequireActiveSubscriptionOrTrial).toHaveBeenCalledWith('org-linear-123');
    const state = mockedGetLinearOAuthUrl.mock.calls[0]?.[0];
    expect(verifyOAuthState(state ?? null)).toEqual(
      expect.objectContaining({
        owner: 'org_org-linear-123',
        userId: USER_ID,
      })
    );
  });

  test('redirects org authorization failures without creating an OAuth URL', async () => {
    mockedEnsureOrganizationAccess.mockRejectedValue(new Error('unauthorized'));

    const response = await callLinearConnect(
      makeRequest('/api/integrations/linear/connect?organizationId=org-linear-123')
    );

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(`${url.pathname}${url.search}`).toBe(
      '/organizations/org-linear-123/integrations/linear?error=oauth_init_failed'
    );
    expect(mockedRequireActiveSubscriptionOrTrial).not.toHaveBeenCalled();
    expect(mockedGetLinearOAuthUrl).not.toHaveBeenCalled();
  });

  test('redirects inactive org subscription failures without creating an OAuth URL', async () => {
    mockedRequireActiveSubscriptionOrTrial.mockRejectedValue(new Error('inactive subscription'));

    const response = await callLinearConnect(
      makeRequest('/api/integrations/linear/connect?organizationId=org-linear-123')
    );

    const location = response.headers.get('location');
    expect(location).toBeTruthy();
    const url = new URL(location ?? '');
    expect(`${url.pathname}${url.search}`).toBe(
      '/organizations/org-linear-123/integrations/linear?error=oauth_init_failed'
    );
    expect(mockedGetLinearOAuthUrl).not.toHaveBeenCalled();
  });

  test('drops invalid returnTo values from signed OAuth state', async () => {
    await callLinearConnect(
      makeRequest('/api/integrations/linear/connect?returnTo=https%3A%2F%2Fevil.example.com%2Fpath')
    );

    const state = mockedGetLinearOAuthUrl.mock.calls[0]?.[0];
    expect(verifyOAuthState(state ?? null)).toEqual(
      expect.objectContaining({
        owner: `user_${USER_ID}`,
        userId: USER_ID,
      })
    );
    expect(verifyOAuthState(state ?? null)).not.toHaveProperty('returnTo');
  });
});
