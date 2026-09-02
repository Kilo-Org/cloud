process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { NextRequest } from 'next/server';

jest.mock('@/lib/device-auth/device-auth');
jest.mock('@/lib/user/server');
jest.mock('@/lib/device-auth/device-auth-viewer-token');
jest.mock('@vercel/firewall');
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof Sentry>('@sentry/nextjs'),
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

import { pollDeviceAuthRequest, denyDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@/lib/user/server';
import { verifyDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { checkRateLimit } from '@vercel/firewall';
import * as Sentry from '@sentry/nextjs';
import { GET, DELETE } from './route';

const mockPoll = jest.mocked(pollDeviceAuthRequest);
const mockDeny = jest.mocked(denyDeviceAuthRequest);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockVerifyToken = jest.mocked(verifyDeviceAuthViewerToken);
const mockCheckRateLimit = jest.mocked(checkRateLimit);

const fakeUser = { id: 'user-1' } as never;

describe('GET /api/device-auth/codes/[code] (legacy poll)', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test('returns 202 for pending', async () => {
    mockPoll.mockResolvedValue({ status: 'pending' });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  test('returns 200 with token for approved', async () => {
    mockPoll.mockResolvedValue({
      status: 'approved',
      token: 'jwt',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'approved',
      token: 'jwt',
      userId: 'user-1',
      userEmail: 'user@example.com',
    });
  });

  test('returns 403 for denied', async () => {
    mockPoll.mockResolvedValue({ status: 'denied' });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(403);
  });

  test('returns 410 for expired', async () => {
    mockPoll.mockResolvedValue({ status: 'expired' });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(410);
  });

  test('returns 400 for missing code', async () => {
    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ code: '' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Code parameter is required' });
    expect(mockPoll).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each(['pending', 'approved', 'denied', 'expired'] as const)(
    'logs exactly one sanitized counter per %s poll without Sentry capture',
    async status => {
      mockPoll.mockResolvedValue({
        status,
        token: 'synthetic-response-token',
        userId: 'synthetic-user',
        userEmail: 'synthetic@example.invalid',
      });

      for (let occurrence = 0; occurrence < 3; occurrence++) {
        await GET(
          new NextRequest('http://localhost/api/device-auth/codes/SYNTHETIC', {
            headers: {
              authorization: 'Bearer synthetic-authorization',
              cookie: 'synthetic-cookie=value',
            },
          }),
          { params: Promise.resolve({ code: 'SYNTHETIC' }) }
        );
      }

      expect(mockPoll.mock.calls).toEqual([['SYNTHETIC'], ['SYNTHETIC'], ['SYNTHETIC']]);
      expect(stdoutSpy.mock.calls).toEqual([
        ['legacy-poll-device-auth-count: 1\n'],
        ['legacy-poll-device-auth-count: 1\n'],
        ['legacy-poll-device-auth-count: 1\n'],
      ]);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    }
  );

  test('counts a failed poll and preserves the thrown error', async () => {
    const error = new Error('Synthetic polling failure');
    mockPoll.mockRejectedValueOnce(error);

    await expect(
      GET(new NextRequest('http://localhost'), {
        params: Promise.resolve({ code: 'SYNTHETIC' }),
      })
    ).rejects.toBe(error);

    expect(stdoutSpy.mock.calls).toEqual([['legacy-poll-device-auth-count: 1\n']]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('bypasses real Sentry console logs and breadcrumbs without suppressing other reporting', async () => {
    const actualSentry = jest.requireActual<typeof Sentry>('@sentry/nextjs');
    const beforeSend = jest.fn(event => event);
    const beforeSendLog = jest.fn(log => log);
    const beforeBreadcrumb = jest.fn(breadcrumb => breadcrumb);
    const send = jest.fn().mockResolvedValue({ statusCode: 200 });
    const client = actualSentry.init({
      dsn: 'https://public@example.invalid/1',
      defaultIntegrations: false,
      integrations: [
        actualSentry.consoleIntegration(),
        actualSentry.consoleLoggingIntegration({ levels: ['info', 'log', 'warn', 'error'] }),
      ],
      enableLogs: true,
      skipOpenTelemetrySetup: true,
      transport: () => ({ send, flush: async () => true }),
      beforeSend,
      beforeSendLog,
      beforeBreadcrumb,
    });

    try {
      mockPoll.mockResolvedValue({ status: 'pending' });
      await GET(new NextRequest('http://localhost'), {
        params: Promise.resolve({ code: 'SYNTHETIC' }),
      });
      await actualSentry.flush();

      expect(stdoutSpy.mock.calls).toEqual([['legacy-poll-device-auth-count: 1\n']]);
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(beforeSend).not.toHaveBeenCalled();
      expect(beforeSendLog).not.toHaveBeenCalled();
      expect(beforeBreadcrumb).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();

      console.info('synthetic unrelated console event');
      actualSentry.captureMessage('synthetic unrelated reportable event');
      await actualSentry.flush();

      expect(beforeSend).toHaveBeenCalled();
      expect(beforeSendLog).toHaveBeenCalled();
      expect(beforeBreadcrumb).toHaveBeenCalled();
      expect(send).toHaveBeenCalled();
    } finally {
      await client?.close();
    }
  });
});

describe('DELETE /api/device-auth/codes/[code] (deny with viewer token)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserFromAuth.mockResolvedValue({ user: fakeUser, authFailedResponse: null });
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false } as never);
  });

  function createRequest(code: string, headers?: Record<string, string>) {
    return new NextRequest(`http://localhost:3000/api/device-auth/codes/${code}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  test('returns 200 on successful deny', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockDeny).toHaveBeenCalledWith('ABCD-EFGH');
  });

  test('returns 403 without viewer token', async () => {
    mockVerifyToken.mockReturnValue(null);

    const response = await DELETE(createRequest('ABCD-EFGH'), {
      params: Promise.resolve({ code: 'ABCD-EFGH' }),
    });
    expect(response.status).toBe(403);
    expect(response.statusText).toBeDefined(); // invalid or expired
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 403 when viewer token code does not match route code', async () => {
    mockVerifyToken.mockReturnValue({ code: 'DIFFERENT', userId: 'user-1' });

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(403);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 403 when viewer token userId does not match authenticated user', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'different-user' });

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(403);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 401 when user is not authenticated', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    } as never);

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(401);
  });

  test('returns 429 when rate limited', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true } as never);

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(429);
    expect(mockDeny).not.toHaveBeenCalled();
  });

  test('returns 400 for missing code', async () => {
    const response = await DELETE(createRequest(''), { params: Promise.resolve({ code: '' }) });
    expect(response.status).toBe(400);
  });

  test('returns 409 on second deny (controlled refusal, not 500)', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockDeny.mockRejectedValue(new Error('Device authorization request is not pending'));

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Device authorization request can no longer be denied',
    });
    expect(mockDeny).toHaveBeenCalledWith('ABCD-EFGH');
  });

  test('returns 404 when deny targets a non-existent request', async () => {
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockDeny.mockRejectedValue(new Error('Device authorization request not found'));

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('reports unexpected deny failures and preserves the 500 response', async () => {
    const error = new Error('Synthetic unexpected deny failure');
    mockVerifyToken.mockReturnValue({ code: 'ABCD-EFGH', userId: 'user-1' });
    mockDeny.mockRejectedValueOnce(error);

    const response = await DELETE(
      createRequest('ABCD-EFGH', { 'x-device-auth-viewer-token': 'valid-token' }),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });
});
