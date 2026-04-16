import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getInstanceById } from '@/lib/kiloclaw/instance-registry';
import {
  exchangeGoogleOAuthCode,
  upsertGoogleOAuthIntegration,
} from '@/lib/integrations/google-service';
import { verifyGoogleOAuthState } from '@/lib/integrations/google/oauth-state';
import { captureException, captureMessage } from '@sentry/nextjs';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user.server');
const mockedEnsureOrganizationAccess = jest.fn();
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockedEnsureOrganizationAccess,
}));
jest.mock('@/lib/kiloclaw/instance-registry');
jest.mock('@/lib/integrations/google-service');
jest.mock('@/lib/integrations/google/oauth-state');
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetInstanceById = jest.mocked(getInstanceById);
const mockedExchangeGoogleOAuthCode = jest.mocked(exchangeGoogleOAuthCode);
const mockedUpsertGoogleOAuthIntegration = jest.mocked(upsertGoogleOAuthIntegration);
const mockedVerifyGoogleOAuthState = jest.mocked(verifyGoogleOAuthState);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';
const INSTANCE_ID = '62f96e7b-e010-4a4f-badb-85af870b9fd9';

function makeRequest(pathWithQuery: string) {
  return new NextRequest(`http://localhost:3000${pathWithQuery}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /api/integrations/google/callback', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    mockedVerifyGoogleOAuthState.mockReturnValue({
      owner: { type: 'user', id: USER_ID },
      userId: USER_ID,
      instanceId: INSTANCE_ID,
      capabilities: ['calendar_read'],
    });

    mockedGetInstanceById.mockResolvedValue({
      id: INSTANCE_ID,
      userId: USER_ID,
      organizationId: null,
    } as never);

    mockedExchangeGoogleOAuthCode.mockResolvedValue({
      refreshToken: 'refresh-token',
      grantedScopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
        'openid',
      ],
      googleSubject: 'google-subject-123',
      googleEmail: 'user@example.com',
      expiresAt: null,
    });

    mockedUpsertGoogleOAuthIntegration.mockResolvedValue();
  });

  test('redirects to sign-in when auth fails', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/users/sign_in');
  });

  test('redirects personal success flow to personal claw settings', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/callback?code=abc&state=signed') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?success=google_connected');
    expect(mockedExchangeGoogleOAuthCode).toHaveBeenCalledWith('abc', ['calendar_read']);
    expect(mockedUpsertGoogleOAuthIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { type: 'user', id: USER_ID },
        instanceId: INSTANCE_ID,
      })
    );
  });

  test('redirects org success flow to org claw settings', async () => {
    mockedVerifyGoogleOAuthState.mockReturnValue({
      owner: { type: 'org', id: ORG_ID },
      userId: USER_ID,
      instanceId: INSTANCE_ID,
      capabilities: ['calendar_read'],
    });

    mockedGetInstanceById.mockResolvedValue({
      id: INSTANCE_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/callback?code=abc&state=signed-org') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/organizations/${ORG_ID}/claw/settings?success=google_connected`);
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
  });

  test('redirects personal OAuth provider errors to personal claw settings', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/callback?error=access_denied&state=signed') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?error=access_denied');
    expect(mockedCaptureMessage).toHaveBeenCalledWith('Google OAuth error', expect.any(Object));
  });

  test('redirects org OAuth provider errors to org claw settings', async () => {
    mockedVerifyGoogleOAuthState.mockReturnValue({
      owner: { type: 'org', id: ORG_ID },
      userId: USER_ID,
      instanceId: INSTANCE_ID,
      capabilities: ['calendar_read'],
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/google/callback?error=access_denied&error_description=user%20cancelled&state=signed-org'
      ) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/organizations/${ORG_ID}/claw/settings?error=user%20cancelled`);
  });

  test('redirects invalid state to personal claw settings invalid_state', async () => {
    mockedVerifyGoogleOAuthState.mockReturnValue(null);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/callback?code=abc&state=invalid') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?error=invalid_state');
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'Google callback invalid or tampered state',
      expect.any(Object)
    );
  });

  test('redirects unexpected failures to org claw settings when state indicates org owner', async () => {
    mockedVerifyGoogleOAuthState.mockReturnValue({
      owner: { type: 'org', id: ORG_ID },
      userId: USER_ID,
      instanceId: INSTANCE_ID,
      capabilities: ['calendar_read'],
    });

    mockedGetInstanceById.mockRejectedValue(new Error('db down'));

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/callback?code=abc&state=signed-org') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, `/organizations/${ORG_ID}/claw/settings?error=connection_failed`);
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });
});
