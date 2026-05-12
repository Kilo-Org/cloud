import { beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { uninstall } from '@/lib/integrations/dolthub-service';
import { captureException } from '@sentry/nextjs';
import { failureResult } from '@/lib/maybe-result';

jest.mock('@/lib/user.server');
const mockedEnsureOrganizationAccess = jest.fn();
jest.mock('@/routers/organizations/utils', () => ({
  ensureOrganizationAccess: mockedEnsureOrganizationAccess,
}));
jest.mock('@/lib/integrations/dolthub-service');
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedUninstall = jest.mocked(uninstall);
const mockedCaptureException = jest.mocked(captureException);

const USER_ID = '034489e8-19e0-4479-9d69-2edad719e847';
const ORG_ID = 'a32ba169-8d90-43f6-98ee-95e509a1b06b';

function makeRequest(path: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
  });
}

function setNodeEnv(value: string) {
  Object.defineProperty(process.env, 'NODE_ENV', {
    value,
    configurable: true,
    writable: true,
  });
}

describe('POST /api/integrations/dolthub/disconnect', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    setNodeEnv('development');

    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: USER_ID },
      authFailedResponse: null,
    } as never);

    mockedUninstall.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
  });

  test('returns 404 in production', async () => {
    setNodeEnv('production');
    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/dolthub/disconnect'));

    expect(response.status).toBe(404);
  });

  test('returns authFailedResponse when user is unauthenticated', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    } as never);

    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/dolthub/disconnect'));

    expect(response.status).toBe(401);
    expect(mockedUninstall).not.toHaveBeenCalled();
  });

  test('disconnects personal flow and returns success', async () => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/dolthub/disconnect'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });
    expect(mockedUninstall).toHaveBeenCalledWith({ type: 'user', id: USER_ID });
  });

  test('disconnects org flow and returns success', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(`/api/integrations/dolthub/disconnect?organizationId=${ORG_ID}`)
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true });
    expect(mockedEnsureOrganizationAccess).toHaveBeenCalledWith({ user: { id: USER_ID } }, ORG_ID);
    expect(mockedUninstall).toHaveBeenCalledWith({ type: 'org', id: ORG_ID });
  });

  test('returns 500 on unexpected error', async () => {
    mockedUninstall.mockRejectedValue(new Error('db down'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest('/api/integrations/dolthub/disconnect'));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'disconnect_failed' });
    expect(mockedCaptureException).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
  });
});
