import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getLinearOAuthUrl } from '@/lib/integrations/linear-service';

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
});
