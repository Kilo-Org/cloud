import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { getDoltHubOAuthUrl } from '@/lib/integrations/dolthub-service';
import { captureException } from '@sentry/nextjs';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user.server');
const mockedEnsureOrganizationAccess = jest.fn();
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockedEnsureOrganizationAccess,
}));
jest.mock('@/lib/integrations/oauth-state');
jest.mock('@/lib/integrations/dolthub-service');
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedCreateOAuthState = jest.mocked(createOAuthState);
const mockedGetDoltHubOAuthUrl = jest.mocked(getDoltHubOAuthUrl);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('GET /api/integrations/dolthub/connect', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    setNodeEnv('development');

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedCreateOAuthState.mockReturnValue('signed-state-123');
    mockedGetDoltHubOAuthUrl.mockReturnValue(
      'https://www.dolthub.com/oauth/authorize?client_id=dhoci.v1.tdg4bfv15v24adbpc2fqeqddugotg64nd9puisim322d0p452i50&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Fintegrations%2Fdolthub%2Fcallback'
    );
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  test('returns 404 in production', async () => {
    setNodeEnv('production');
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/dolthub/connect'));

    expect(response.status).toBe(404);
  });

  test('returns authFailedResponse when user is unauthenticated', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/dolthub/connect'));

    expect(response.status).toBe(401);
  });

  test('redirects personal flow to DoltHub OAuth URL containing client ID and redirect URI', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/dolthub/connect'));

    expect(response.status).toBe(307);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('client_id=');
    expect(location).toContain('redirect_uri=');
    expect(mockedCreateOAuthState).toHaveBeenCalledWith(`user_${USER_ID}`, USER_ID);
    expect(mockedGetDoltHubOAuthUrl).toHaveBeenCalledWith('signed-state-123');
  });

  test('redirects org flow to DoltHub OAuth URL', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/connect?organizationId=${ORG_ID}`)
    );

    expect(response.status).toBe(307);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('client_id=');
    expect(location).toContain('redirect_uri=');
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedCreateOAuthState).toHaveBeenCalledWith(`org_${ORG_ID}`, USER_ID);
  });

  test('redirects to error page on unexpected error', async () => {
    mockedGetDoltHubOAuthUrl.mockImplementation(() => {
      throw new Error('boom');
    });

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/dolthub/connect'));

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=oauth_init_failed');
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });
});
