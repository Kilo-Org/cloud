import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { buildGoogleOAuthUrl } from '@/lib/integrations/google-service';
import { createGoogleOAuthState } from '@/lib/integrations/google/oauth-state';
import type * as OAuthStateModule from '@/lib/integrations/google/oauth-state';
import { captureException, captureMessage } from '@sentry/nextjs';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user/server');
const mockedEnsureOrganizationAccess = jest.fn();
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockedEnsureOrganizationAccess,
}));
const mockedRequireKiloClawAccess = jest.fn();
jest.mock('@/lib/kiloclaw/access-gate', () => ({
  requireKiloClawAccess: mockedRequireKiloClawAccess,
}));
const mockedRequireOrganizationKiloClawComputeEntitlement = jest.fn();
jest.mock('@/lib/organizations/trial-middleware', () => ({
  requireOrganizationKiloClawComputeEntitlement:
    mockedRequireOrganizationKiloClawComputeEntitlement,
}));
jest.mock('@/lib/kiloclaw/instance-registry');
jest.mock('@/lib/integrations/google-service');
// Partial-mock so GOOGLE_OAUTH_RETURN_TO_REGEX (and any other constants) keep
// their real values; only the createGoogleOAuthState / verifyGoogleOAuthState
// functions need to be jest.fn() for assertions.
jest.mock('@/lib/integrations/google/oauth-state', () => {
  const actual = jest.requireActual<typeof OAuthStateModule>(
    '@/lib/integrations/google/oauth-state'
  );
  return {
    ...actual,
    createGoogleOAuthState: jest.fn(),
    verifyGoogleOAuthState: jest.fn(),
  };
});
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
    expect(mockedRequireKiloClawAccess).toHaveBeenCalledWith(USER_ID);
    expect(mockedGetActiveInstance).toHaveBeenCalledWith(USER_ID);
    expect(mockedGetActiveOrgInstance).not.toHaveBeenCalled();
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: false });
    expect(mockedCreateGoogleOAuthState).toHaveBeenCalledWith(
      {
        owner: { type: 'user', id: USER_ID },
        instanceId: INSTANCE_ID,
        capabilities: ['calendar_read'],
      },
      USER_ID
    );
  });

  test('does not initiate personal OAuth without active KiloClaw access', async () => {
    mockedRequireKiloClawAccess.mockRejectedValue(new Error('access denied'));

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/google/connect') as never);

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?error=oauth_init_failed');
    expect(mockedGetActiveInstance).not.toHaveBeenCalled();
    expect(mockedBuildGoogleOAuthUrl).not.toHaveBeenCalled();
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });

  test('redirects entitled org flow to Google OAuth URL', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(`/api/integrations/google/connect?organizationId=${ORG_ID}`) as never
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1'
    );
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedRequireOrganizationKiloClawComputeEntitlement).toHaveBeenCalledWith(ORG_ID);
    expect(mockedRequireKiloClawAccess).not.toHaveBeenCalled();
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

  test('passes a valid returnTo through to the OAuth state', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/google/connect?returnTo=%2Fclaw%2Fnew%3Fstep%3Dcalendar'
      ) as never
    );

    expect(response.status).toBe(307);
    expect(mockedCreateGoogleOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { type: 'user', id: USER_ID },
        instanceId: INSTANCE_ID,
        capabilities: ['calendar_read'],
        returnTo: '/claw/new?step=calendar',
      }),
      USER_ID
    );
  });

  test('passes organizationId and returnTo through to the OAuth state for org flow', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/google/connect?organizationId=${ORG_ID}&returnTo=%2Forganizations%2F${ORG_ID}%2Fclaw%2Fnew%3Fstep%3Dcalendar`
      ) as never
    );

    expect(response.status).toBe(307);
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedGetActiveOrgInstance).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(mockedCreateGoogleOAuthState).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: { type: 'org', id: ORG_ID },
        instanceId: INSTANCE_ID,
        capabilities: ['calendar_read'],
        returnTo: `/organizations/${ORG_ID}/claw/new?step=calendar`,
      }),
      USER_ID
    );
  });

  test('drops protocol-relative returnTo values to prevent open redirects', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/connect?returnTo=%2F%2Fevil.example.com') as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });

  test('drops absolute-URL returnTo values', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/google/connect?returnTo=https%3A%2F%2Fevil.example.com%2Fclaw%2Fnew'
      ) as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });

  test('drops returnTo values with path-traversal segments', async () => {
    // /claw/../admin would normalize to /admin after URL resolution. Even
    // though the regex permits it, we reject any `.` or `..` segment for
    // defense in depth.
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/connect?returnTo=%2Fclaw%2F..%2Fadmin') as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });

  test('drops returnTo values with percent-encoded path-traversal segments', async () => {
    // /claw/%2e%2e/admin decodes to /claw/../admin which would normalize to
    // /admin in the callback. The decoder-then-segment check must catch this.
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/connect?returnTo=%2Fclaw%2F%2e%2e%2Fadmin') as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });

  test('drops returnTo values starting with a backslash escape', async () => {
    // WHATWG URL parsing for the https scheme treats `\` as a path separator,
    // so `/\evil.example.com/path` normalizes to https://evil.example.com/path
    // when the callback constructs new URL(returnTo, APP_URL).
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/google/connect?returnTo=%2F%5Cevil.example.com%2Fpath'
      ) as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });

  test('drops returnTo values containing C0 control characters', async () => {
    // %0A (newline) is silently stripped by WHATWG URL parsing, so a
    // crafted /%0A/evil.example.com/path would pass a string-shape regex
    // and then normalize to https://evil.example.com/path in the callback.
    const { GET } = await import('./route');

    for (const encoded of ['%0A', '%0D', '%09', '%00']) {
      mockedCreateGoogleOAuthState.mockClear();
      const response = await GET(
        makeRequest(
          `/api/integrations/google/connect?returnTo=%2F${encoded}%2Fevil.example.com%2Fpath`
        ) as never
      );
      expect(response.status).toBe(307);
      const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
      expect(stateArg).toBeDefined();
      expect(stateArg).not.toHaveProperty('returnTo');
    }
  });

  test('drops returnTo values containing a mid-path backslash', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/connect?returnTo=%2Fclaw%5Cevil%2Fpath') as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });

  test('drops returnTo values with a URI fragment', async () => {
    // Fragments are disallowed by RETURN_TO_REGEX because the helpers in
    // callback/route.ts append the success/error param using a `?`/`&`
    // separator; a fragment in the returnTo would push the param past the
    // `#` where browsers ignore it.
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest('/api/integrations/google/connect?returnTo=%2Fclaw%2Fnew%23section') as never
    );

    expect(response.status).toBe(307);
    const stateArg = mockedCreateGoogleOAuthState.mock.calls.at(0)?.[0];
    expect(stateArg).toBeDefined();
    expect(stateArg).not.toHaveProperty('returnTo');
  });
});
