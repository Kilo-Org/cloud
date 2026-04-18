import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { buildGoogleOAuthUrl } from '@/lib/integrations/google-service';
import { createGoogleOAuthState } from '@/lib/integrations/google/oauth-state';
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
const mockedGetActiveInstance = jest.mocked(getActiveInstance);
const mockedGetActiveOrgInstance = jest.mocked(getActiveOrgInstance);
const mockedBuildGoogleOAuthUrl = jest.mocked(buildGoogleOAuthUrl);
const mockedCreateGoogleOAuthState = jest.mocked(createGoogleOAuthState);
const mockedCaptureException = jest.mocked(captureException);
const mockedCaptureMessage = jest.mocked(captureMessage);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';
const INSTANCE_ID = '62f96e7b-e010-4a4f-badb-85af870b9fd9';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('GET /api/integrations/google/connect', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);
    mockedGetActiveInstance.mockResolvedValue({ id: INSTANCE_ID } as never);
    mockedGetActiveOrgInstance.mockResolvedValue({ id: INSTANCE_ID } as never);
    mockedCreateGoogleOAuthState.mockReturnValue('state-123');
    mockedBuildGoogleOAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1');
  });

  test('redirects to sign-in when auth fails', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/google/connect') as never);

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/users/sign_in');
  });

  test('redirects personal flow to Google OAuth URL', async () => {
    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/google/connect') as never);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    );
    expect(mockedGetActiveInstance).toHaveBeenCalledWith(USER_ID);
    expect(mockedGetActiveOrgInstance).not.toHaveBeenCalled();
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(mockedCreateGoogleOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
        instanceId: INSTANCE_ID,
        capabilities: ['calendar_read'],
      },
      USER_ID
    );
  });

  test('redirects org flow to Google OAuth URL', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/google/connect?organizationId=${ORG_ID}`) as never
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    );
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedGetActiveOrgInstance).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(mockedCreateGoogleOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'org', id: ORG_ID },
        instanceId: INSTANCE_ID,
        capabilities: ['calendar_read'],
      },
      USER_ID
    );
  });

  test('redirects personal missing-instance errors to claw settings', async () => {
    mockedGetActiveInstance.mockResolvedValue(null);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/google/connect') as never);

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?error=missing_instance');
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'Google connect missing active KiloClaw instance',
      expect.any(Object)
    );
  });

  test('redirects org init failures to org claw settings', async () => {
    mockedBuildGoogleOAuthUrl.mockImplementation(() => {
      throw new Error('boom');
    });

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/google/connect?organizationId=${ORG_ID}`) as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(
      response,
      `/organizations/${ORG_ID}/claw/settings?error=oauth_init_failed`
    );
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });

  test('redirects invalid organization IDs to personal claw settings error page', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/connect?organizationId=not-a-uuid') as never
    );

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?error=invalid_organization');
    expect(mockedEnsureOrganizationAccess).not.toHaveBeenCalled();
  });
});
