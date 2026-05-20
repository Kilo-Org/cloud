import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getLinearOAuthUrl } from '@/lib/integrations/linear-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';

jest.mock('@/lib/user.server');
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
