import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { completeManagedComposioGoogleCalendarConnection } from '@/lib/kiloclaw/composio-onboarding';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user.server');
jest.mock('@/lib/kiloclaw/instance-registry');
jest.mock('@/lib/kiloclaw/composio-onboarding');
const mockedEnsureOrganizationAccess = jest.fn();
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockedEnsureOrganizationAccess,
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetActiveInstance = jest.mocked(getActiveInstance);
const mockedGetActiveOrgInstance = jest.mocked(getActiveOrgInstance);
const mockedCompleteManagedComposioGoogleCalendarConnection = jest.mocked(
  completeManagedComposioGoogleCalendarConnection
);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';
const INSTANCE_ID = '62f96e7b-e010-4a4f-badb-85af870b9fd9';
const fakeInstance = {
  id: INSTANCE_ID,
  userId: USER_ID,
  sandboxId: 'sandbox-1',
  organizationId: null,
  name: null,
  inboundEmailEnabled: false,
  composioConfigSource: null,
};

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`);
}

function redirectPath(response: Response): string {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  return `${url.pathname}${url.search}`;
}

async function responseBody(response: Response): Promise<string> {
  return await response.text();
}

describe('GET /api/integrations/composio/callback', () => {
  beforeEach(() => {
    jest.resetAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID, is_admin: false },
      authFailedResponse: null,
    } as never);
    mockedGetActiveInstance.mockResolvedValue(fakeInstance as never);
    mockedGetActiveOrgInstance.mockResolvedValue(fakeInstance as never);
    mockedCompleteManagedComposioGoogleCalendarConnection.mockResolvedValue(true);
  });

  test('redirects to sign-in when auth fails', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(makeRequest('/api/integrations/composio/callback') as never);

    expect(response.status).toBe(307);
    expect(redirectPath(response)).toBe('/users/sign_in');
  });

  test('returns popup failure instead of sign-in redirect when popup auth fails', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/composio/callback?popup=1&attemptId=attempt-1&status=success'
      ) as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    const body = await responseBody(response);
    expect(body).toContain('kiloclaw:composio-connect');
    expect(body).toContain('attempt-1');
    expect(body).toContain('unauthorized');
    expect(body).toContain('BroadcastChannel');
  });

  test('rejects backslash-prefixed returnTo values instead of redirecting externally', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/composio/callback?returnTo=%2F%5Cevil.example.com%2Fpath&status=failed'
      ) as never
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/claw/new?step=tools');
    expect(response.headers.get('location')).not.toContain('evil.example.com');
  });

  test('does not emit success until the connected account verifies against Composio', async () => {
    mockedCompleteManagedComposioGoogleCalendarConnection.mockResolvedValue(false);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/composio/callback?returnTo=%2Fclaw%2Fnew%3Fstep%3Dtools&status=success&connected_account_id=ca_123'
      ) as never
    );

    expect(redirectPath(response)).toBe('/claw/new?step=tools&error=connection_failed');
    expect(mockedCompleteManagedComposioGoogleCalendarConnection).toHaveBeenCalledWith({
      userId: USER_ID,
      instance: fakeInstance,
      scope: { ownerType: 'user', userId: USER_ID },
      connectedAccountId: 'ca_123',
    });
  });

  test('emits success after verifying and applying managed credentials', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/composio/callback?organizationId=${ORG_ID}&returnTo=%2Forganizations%2F${ORG_ID}%2Fclaw%2Fnew%3Fstep%3Dtools&status=success&connected_account_id=ca_123`
      ) as never
    );

    expect(redirectPath(response)).toBe(
      `/organizations/${ORG_ID}/claw/new?step=tools&success=composio_connected`
    );
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: { id: USER_ID, is_admin: false } },
      ORG_ID
    );
    expect(mockedGetActiveOrgInstance).toHaveBeenCalledWith(USER_ID, ORG_ID);
    expect(mockedCompleteManagedComposioGoogleCalendarConnection).toHaveBeenCalledWith({
      userId: USER_ID,
      instance: fakeInstance,
      scope: { ownerType: 'organization_user', userId: USER_ID, organizationId: ORG_ID },
      connectedAccountId: 'ca_123',
    });
  });

  test('returns popup success document after verifying managed credentials', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/composio/callback?popup=1&organizationId=${ORG_ID}&returnTo=%2Forganizations%2F${ORG_ID}%2Fclaw%2Fnew%3Fstep%3Dtools&status=success&connected_account_id=ca_123`
      ) as never
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const body = await responseBody(response);
    expect(body).toContain('Google Calendar connected');
    expect(body).toContain('Close popup');
    expect(body).toContain('localStorage.setItem');
    expect(body).toContain('window.opener.postMessage');
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith(
      { user: { id: USER_ID, is_admin: false } },
      ORG_ID
    );
    expect(mockedCompleteManagedComposioGoogleCalendarConnection).toHaveBeenCalledWith({
      userId: USER_ID,
      instance: fakeInstance,
      scope: { ownerType: 'organization_user', userId: USER_ID, organizationId: ORG_ID },
      connectedAccountId: 'ca_123',
    });
  });

  test('includes popup attempt id in success document payload', async () => {
    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/composio/callback?popup=1&attemptId=attempt-2&organizationId=${ORG_ID}&returnTo=%2Forganizations%2F${ORG_ID}%2Fclaw%2Fnew%3Fstep%3Dtools&status=success&connected_account_id=ca_123`
      ) as never
    );

    const body = await responseBody(response);
    expect(body).toContain('attempt-2');
  });

  test('reports internal callback failures separately from authorization failures', async () => {
    mockedCompleteManagedComposioGoogleCalendarConnection.mockRejectedValue(
      new Error('db unavailable')
    );

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        '/api/integrations/composio/callback?returnTo=%2Fclaw%2Fnew%3Fstep%3Dtools&status=success&connected_account_id=ca_123'
      ) as never
    );

    expect(redirectPath(response)).toBe('/claw/new?step=tools&error=internal_error');
  });

  test('escapes popup attempt id before embedding it in inline scripts', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { GET } = await import('./route');
    const response = await GET(
      makeRequest(
        `/api/integrations/composio/callback?popup=1&attemptId=${encodeURIComponent('</script><script>alert(1)</script>')}&status=success`
      ) as never
    );

    const body = await responseBody(response);
    expect(body).not.toContain('</script><script>alert(1)</script>');
    expect(body).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
  });
});
