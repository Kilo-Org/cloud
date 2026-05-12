import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import {
  exchangeDoltHubOAuthCode,
  upsertDoltHubInstallation,
} from '@/lib/integrations/dolthub-service';
import { captureException, captureMessage } from '@sentry/nextjs';
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
const mockedVerifyOAuthState = jest.mocked(verifyOAuthState);
const mockedExchangeDoltHubOAuthCode = jest.mocked(exchangeDoltHubOAuthCode);
const mockedUpsertDoltHubInstallation = jest.mocked(upsertDoltHubInstallation);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const OTHER_USER_ID = 'c00b91a1-6959-4b04-9ef8-e8d37b340f4a';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
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

describe('GET /api/integrations/dolthub/callback', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    setNodeEnv('development');
    originalFetch = global.fetch;

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    mockedVerifyOAuthState.mockReturnValue({
      owner: `user_${USER_ID}`,
      userId: USER_ID,
    });

    mockedExchangeDoltHubOAuthCode.mockResolvedValue({
      accessToken: 'access-token-123',
      refreshToken: 'refresh-token-123',
      expiresIn: 3600,
      scope: 'api_read_write',
    });

    mockedUpsertDoltHubInstallation.mockResolvedValue({} as never);

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rows: [{ username: 'test-dolthub-user' }] }),
    } as unknown as Response);
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    global.fetch = originalFetch;
  });

  test('returns 404 in production', async () => {
    setNodeEnv('production');
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/dolthub/callback?code=abc&state=s'));

    expect(response.status).toBe(404);
  });

  test('redirects to sign-in when user is unauthenticated', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/dolthub/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/users/sign_in');
  });

  test('redirects with oauth error when DoltHub returns one', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `user_${USER_ID}`, userId: USER_ID });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/callback?error=access_denied&state=${state}`)
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=access_denied');
    expect(mockedCaptureMessage).toHaveBeenCalledWith('DoltHub OAuth error', expect.any(Object));
  });

  test('redirects with missing_code when no code is present', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `user_${USER_ID}`, userId: USER_ID });

    const { GET } = await import('./route');
    const response = await GET(makeRequest(`/api/integrations/dolthub/callback?state=${state}`));

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=missing_code');
  });

  test('rejects an invalid state signature', async () => {
    mockedVerifyOAuthState.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/dolthub/callback?code=abc&state=forged.sig')
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=invalid_state');
  });

  test('rejects when the state was signed for a different user', async () => {
    mockedVerifyOAuthState.mockReturnValue({
      owner: `user_${OTHER_USER_ID}`,
      userId: OTHER_USER_ID,
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/dolthub/callback?code=abc&state=signed')
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=unauthorized');
  });

  test('successful personal exchange persists installation and redirects to personal hub', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `user_${USER_ID}`, userId: USER_ID });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/callback?code=abc&state=${state}`)
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub');
    expect(mockedExchangeDoltHubOAuthCode).toHaveBeenCalledWith('abc');
    expect(mockedUpsertDoltHubInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { type: 'user', id: USER_ID },
        account: { username: 'test-dolthub-user' },
        tokens: {
          accessToken: 'access-token-123',
          refreshToken: 'refresh-token-123',
          expiresIn: 3600,
          scope: 'api_read_write',
        },
      })
    );
  });

  test('successful org exchange persists installation and redirects to org hub', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `org_${ORG_ID}`, userId: USER_ID });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/callback?code=abc&state=${state}`)
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/organizations/${ORG_ID}/integrations/dolthub`);
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedUpsertDoltHubInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { type: 'org', id: ORG_ID },
      })
    );
  });

  test('token-exchange failure redirects with ?error=token_exchange_failed', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `user_${USER_ID}`, userId: USER_ID });
    mockedExchangeDoltHubOAuthCode.mockRejectedValue(new Error('token exchange failed'));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/callback?code=abc&state=${state}`)
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=token_exchange_failed');
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });

  test('falls back to pending username when identity lookup fails', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `user_${USER_ID}`, userId: USER_ID });
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/callback?code=abc&state=${state}`)
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub');
    expect(mockedUpsertDoltHubInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        account: { username: 'pending' },
      })
    );
  });

  test('unexpected error redirects with ?error=installation_failed', async () => {
    const state = 'signed-state';
    mockedVerifyOAuthState.mockReturnValue({ owner: `user_${USER_ID}`, userId: USER_ID });
    mockedUpsertDoltHubInstallation.mockRejectedValue(new Error('db down'));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/dolthub/callback?code=abc&state=${state}`)
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/integrations/dolthub?error=installation_failed');
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });
});
