import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import {
  clearKiloClawGoogleOAuthConnection,
  getKiloClawGoogleOAuthConnection,
} from '@/lib/kiloclaw/google-oauth-connections';
import { captureException, captureMessage } from '@sentry/nextjs';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user.server');
const mockedEnsureOrganizationAccess = jest.fn();
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockedEnsureOrganizationAccess,
}));
jest.mock('@/lib/kiloclaw/instance-registry');
jest.mock('@/lib/kiloclaw/google-oauth-connections');
const mockedClearGoogleOAuthConnection = jest.fn();
jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    clearGoogleOAuthConnection: mockedClearGoogleOAuthConnection,
  })),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetActiveInstance = jest.mocked(getActiveInstance);
const mockedGetActiveOrgInstance = jest.mocked(getActiveOrgInstance);
const mockedClearKiloClawGoogleOAuthConnection = jest.mocked(clearKiloClawGoogleOAuthConnection);
const mockedGetKiloClawGoogleOAuthConnection = jest.mocked(getKiloClawGoogleOAuthConnection);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';
const INSTANCE_ID = '62f96e7b-e010-4a4f-badb-85af870b9fd9';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost:3000',
    },
  });
}

function expectRedirectLocation(response: Response, expectedPathWithQuery: string) {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location ?? '');
  expect(`${url.pathname}${url.search}`).toBe(expectedPathWithQuery);
}

describe('POST /api/integrations/google/disconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    mockedGetActiveInstance.mockResolvedValue({ id: INSTANCE_ID } as never);
    mockedGetActiveOrgInstance.mockResolvedValue({ id: INSTANCE_ID } as never);
    mockedGetKiloClawGoogleOAuthConnection.mockResolvedValue({
      account_email: 'user@example.com',
      account_subject: 'sub-1',
    } as never);
    mockedClearKiloClawGoogleOAuthConnection.mockResolvedValue();
    mockedClearGoogleOAuthConnection.mockResolvedValue({
      googleOAuthConnected: false,
      googleOAuthStatus: 'disconnected',
    });
  });

  test('redirects to sign-in when auth fails', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/google/disconnect') as never);

    expect(response.status).toBe(303);
    expectRedirectLocation(response, '/users/sign_in');
  });

  test('disconnects personal flow and redirects to claw settings', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/google/disconnect') as never);

    expect(response.status).toBe(303);
    expectRedirectLocation(response, '/claw/settings?success=google_disconnected');
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({ adminOnly: true });
    expect(mockedGetActiveInstance).toHaveBeenCalledWith(USER_ID);
    expect(mockedGetKiloClawGoogleOAuthConnection).toHaveBeenCalledWith(INSTANCE_ID);
    expect(mockedClearKiloClawGoogleOAuthConnection).toHaveBeenCalledWith(INSTANCE_ID);
    expect(mockedClearGoogleOAuthConnection).toHaveBeenCalledWith(USER_ID, INSTANCE_ID);

    const doClearOrder = mockedClearGoogleOAuthConnection.mock.invocationCallOrder[0] ?? -1;
    const dbClearOrder = mockedClearKiloClawGoogleOAuthConnection.mock.invocationCallOrder[0] ?? -1;
    expect(dbClearOrder).toBeGreaterThan(0);
    expect(doClearOrder).toBeGreaterThan(dbClearOrder);
  });

  test('disconnects org flow and redirects to org claw settings', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(`/api/integrations/google/disconnect?organizationId=${ORG_ID}`) as never
    );

    expect(response.status).toBe(303);
    expectRedirectLocation(
      response,
      `/organizations/${ORG_ID}/claw/settings?success=google_disconnected`
    );
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedGetActiveOrgInstance).toHaveBeenCalledWith(USER_ID, ORG_ID);
  });

  test('redirects missing-instance errors to claw settings', async () => {
    mockedGetActiveInstance.mockResolvedValue(null);

    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/google/disconnect') as never);

    expect(response.status).toBe(303);
    expectRedirectLocation(response, '/claw/settings?error=missing_instance');
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'Google disconnect missing active KiloClaw instance',
      expect.any(Object)
    );
  });

  test('redirects failures to disconnect_failed', async () => {
    mockedClearKiloClawGoogleOAuthConnection.mockRejectedValue(new Error('db down'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/google/disconnect') as never);

    expect(response.status).toBe(303);
    expectRedirectLocation(response, '/claw/settings?error=disconnect_failed');
    expect(mockedClearGoogleOAuthConnection).not.toHaveBeenCalled();
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });

  test('still deletes DB row when DO clear fails (fail-closed)', async () => {
    mockedClearGoogleOAuthConnection.mockRejectedValue(new Error('do down'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/google/disconnect') as never);

    expect(response.status).toBe(303);
    expectRedirectLocation(response, '/claw/settings?error=disconnect_failed');
    expect(mockedClearKiloClawGoogleOAuthConnection).toHaveBeenCalledWith(INSTANCE_ID);
  });

  test('rejects invalid origin', async () => {
    const request = new NextRequest('http://localhost:3000/api/integrations/google/disconnect', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });

    const { POST } = await import('./route');
    const response = await POST(request as never);

    expect(response.status).toBe(303);
    expectRedirectLocation(response, '/claw/settings?error=invalid_origin');
    expect(mockedClearKiloClawGoogleOAuthConnection).not.toHaveBeenCalled();
  });

  test('GET redirects with method_not_allowed and does not mutate state', async () => {
    const { GET } = await import('./route');
    const response = await GET();

    expect(response.status).toBe(307);
    expectRedirectLocation(response, '/claw/settings?error=method_not_allowed');
    expect(mockedClearGoogleOAuthConnection).not.toHaveBeenCalled();
    expect(mockedClearKiloClawGoogleOAuthConnection).not.toHaveBeenCalled();
  });
});
