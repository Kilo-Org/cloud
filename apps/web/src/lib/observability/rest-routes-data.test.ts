process.env.NEXTAUTH_SECRET ||= 'test-nextauth-secret';

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { NextResponse } from 'next/server';

// The route handlers wrapped by `withRestTiming` in this slice. Every module is
// imported through its public export so the test drives the same function the
// Next runtime does.
jest.mock('next/headers', () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

jest.mock('@/lib/device-auth/device-auth', () => {
  class DeviceAuthPendingLimitError extends Error {}
  return {
    DeviceAuthPendingLimitError,
    createDeviceAuthRequest: jest.fn(),
    pollDeviceAuthRequest: jest.fn(),
    denyDeviceAuthRequest: jest.fn(),
    consumeDeviceAuthByDeviceCode: jest.fn(),
    approveDeviceAuthRequest: jest.fn(),
  };
});

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromAuth: jest.fn(),
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));

jest.mock('@/lib/device-auth/device-auth-viewer-token', () => ({
  verifyDeviceAuthViewerToken: jest.fn(),
}));

jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { createDeviceAuthRequest, pollDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import * as codesRoute from '@/app/api/device-auth/codes/route';
import * as codesCodeRoute from '@/app/api/device-auth/codes/[code]/route';
import * as tokenRoute from '@/app/api/device-auth/token/route';
import * as tokensRoute from '@/app/api/device-auth/tokens/route';
import * as streamTicketRoute from '@/app/api/cloud-agent-next/sessions/stream-ticket/route';

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.2.3',
  'x-kilo-request-id': 'req-123',
};

const mockCreateDeviceAuthRequest = jest.mocked(createDeviceAuthRequest);
const mockPollDeviceAuthRequest = jest.mocked(pollDeviceAuthRequest);
const mockGetUserFromAuth = jest.mocked(getUserFromAuth);

let logSpy: jest.SpiedFunction<typeof console.log>;

beforeEach(() => {
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function makeRequest(url: string, method = 'POST', body?: string) {
  return new Request(url, {
    method,
    headers: { ...MOBILE_HEADERS, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  });
}

/** Only the structured timing lines, ignoring any other console output. */
function timingLines(): Record<string, unknown>[] {
  return logSpy.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line?.type === 'api_timing');
}

function expectSingleTimingLine(route: string, method: string, ok = true) {
  const lines = timingLines();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    type: 'api_timing',
    surface: 'rest',
    route,
    method,
    ok,
    client: 'mobile',
    platform: 'ios',
    version: '1.2.3',
    requestId: 'req-123',
  });
  expect(lines[0]?.durationMs).toEqual(expect.any(Number));
}

describe('REST data routes emit one api_timing line', () => {
  test('POST /api/device-auth/codes', async () => {
    mockCreateDeviceAuthRequest.mockResolvedValue({
      code: 'poll-value-for-the-requesting-client',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 600_000),
    });

    const response = await codesRoute.POST(
      makeRequest('https://app.kilo.ai/api/device-auth/codes')
    );

    expect(response.status).toBe(200);
    expectSingleTimingLine('/api/device-auth/codes', 'POST');
  });

  test('POST /api/device-auth/codes logs the line when the handler throws', async () => {
    mockCreateDeviceAuthRequest.mockRejectedValue(new Error('unexpected'));

    await expect(
      codesRoute.POST(makeRequest('https://app.kilo.ai/api/device-auth/codes'))
    ).rejects.toThrow('unexpected');

    expectSingleTimingLine('/api/device-auth/codes', 'POST', false);
  });

  test('GET /api/device-auth/codes/[code]', async () => {
    mockPollDeviceAuthRequest.mockResolvedValue({ status: 'pending' });

    const response = await codesCodeRoute.GET(
      makeRequest('https://app.kilo.ai/api/device-auth/codes/ABCD-EFGH', 'GET'),
      { params: Promise.resolve({ code: 'ABCD-EFGH' }) }
    );

    expect(response.status).toBe(202);
    expectSingleTimingLine('/api/device-auth/codes/[code]', 'GET');
  });

  test('DELETE /api/device-auth/codes/[code]', async () => {
    const response = await codesCodeRoute.DELETE(
      makeRequest('https://app.kilo.ai/api/device-auth/codes/ABCD-EFGH', 'DELETE'),
      { params: Promise.resolve({ code: '' }) }
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/device-auth/codes/[code]', 'DELETE');
  });

  test('POST /api/device-auth/token', async () => {
    const response = await tokenRoute.POST(
      makeRequest('https://app.kilo.ai/api/device-auth/token', 'POST', '{')
    );

    expect(response.status).toBe(400);
    expectSingleTimingLine('/api/device-auth/token', 'POST');
  });

  test('POST /api/device-auth/tokens', async () => {
    const response = await tokensRoute.POST(
      makeRequest('https://app.kilo.ai/api/device-auth/tokens', 'POST', '{}')
    );

    expect(response.status).toBe(403);
    expectSingleTimingLine('/api/device-auth/tokens', 'POST');
  });

  test('POST /api/cloud-agent-next/sessions/stream-ticket', async () => {
    mockGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never);

    const response = await streamTicketRoute.POST(
      makeRequest('https://app.kilo.ai/api/cloud-agent-next/sessions/stream-ticket', 'POST', '{}')
    );

    expect(response.status).toBe(401);
    expectSingleTimingLine('/api/cloud-agent-next/sessions/stream-ticket', 'POST');
  });
});
