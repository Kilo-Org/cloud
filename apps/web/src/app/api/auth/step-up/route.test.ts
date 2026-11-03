import { NextRequest, NextResponse } from 'next/server';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/auth/session-step-up', () => ({
  ...jest.requireActual('@/lib/auth/session-step-up'),
  createStepUpOptions: jest.fn(),
  verifyStepUp: jest.fn(),
}));
jest.mock('@vercel/firewall');
jest.mock('@sentry/nextjs');

import { getUserFromSessionForStepUp } from '@kilocode/web-shared/lib/user/server';
import {
  createStepUpOptions,
  StepUpVerificationError,
  verifyStepUp,
} from '@/lib/auth/session-step-up';
import { checkRateLimit } from '@vercel/firewall';
import { POST } from './route';
import { __test__ as rateLimitTest } from '@/lib/auth/firewall-rate-limit';

const mockGetSession = jest.mocked(getUserFromSessionForStepUp);
const mockCreateStepUpOptions = jest.mocked(createStepUpOptions);
const mockVerifyStepUp = jest.mocked(verifyStepUp);
const mockCheckRateLimit = jest.mocked(checkRateLimit);

const origin = 'http://localhost:3000';
const fakeUser = {
  id: 'user-1',
  google_user_email: 'admin@example.com',
  google_user_name: 'Admin',
};
const challengeId = '11111111-1111-4111-8111-111111111111';

const assertion = {
  id: 'credential-1',
  rawId: 'credential-1',
  type: 'public-key',
  response: {
    clientDataJSON: 'client-data',
    authenticatorData: 'authenticator-data',
    signature: 'signature',
  },
  clientExtensionResults: {},
};

function createRequest(
  body: unknown,
  headers: Record<string, string> = { origin, 'Content-Type': 'application/json' }
): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/step-up', {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    user: fakeUser,
    authFailedResponse: null,
    webSessionId: 'browser-session',
    webSessionPepper: 'pepper',
    ...overrides,
  } as never;
}

describe('POST /api/auth/step-up', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rateLimitTest.resetReportThrottle();
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    mockGetSession.mockResolvedValue(session());
  });

  it.each([
    ['an admin API key', { authorization: 'Bearer admin-key' }],
    [
      'a cookie and a bearer token',
      { cookie: 'next-auth.session-token=x', authorization: 'Bearer x' },
    ],
  ])('refuses %s before reading the session', async (_label, headers) => {
    const response = await POST(createRequest({ action: 'options' }, { ...headers, origin }));

    expect(response.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing Origin', {}],
    ['a foreign Origin', { origin: 'https://evil.example' }],
  ])('refuses %s', async (_label, headers) => {
    const response = await POST(
      createRequest({ action: 'options' }, { ...headers, 'Content-Type': 'application/json' })
    );

    expect(response.status).toBe(403);
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns the auth failure for a non-admin or missing session', async () => {
    mockGetSession.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(403);
  });

  it('tells a legacy session to sign in again', async () => {
    mockGetSession.mockResolvedValue(session({ webSessionId: undefined }));

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'SESSION_UNBOUND' });
  });

  it('mints options and applies the options rate limit per admin', async () => {
    mockCreateStepUpOptions.mockResolvedValue({
      challengeId,
      options: { challenge: 'stored-challenge', rpId: 'localhost' },
    } as never);

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      challengeId,
      options: { challenge: 'stored-challenge', rpId: 'localhost' },
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('admin-step-up-options', {
      request: expect.any(NextRequest),
      rateLimitKey: 'admin-step-up-options:user-1',
    });
    expect(mockCreateStepUpOptions).toHaveBeenCalledWith({
      userId: 'user-1',
      webSessionId: 'browser-session',
      actionClass: 'platform_read',
    });
  });

  it('verifies an assertion and applies the verify rate limit', async () => {
    mockVerifyStepUp.mockResolvedValue({ expires_at: '2030-01-01T00:00:00.000Z' } as never);

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: assertion })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verified: true,
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(mockCheckRateLimit).toHaveBeenCalledWith('admin-step-up-verify', {
      request: expect.any(NextRequest),
      rateLimitKey: 'admin-step-up-verify:user-1',
    });
    expect(mockVerifyStepUp).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        webSessionId: 'browser-session',
        challengeId,
      })
    );
  });

  it('maps a refused ceremony to the stable error code', async () => {
    mockVerifyStepUp.mockRejectedValue(new StepUpVerificationError('CHALLENGE_ALREADY_USED'));

    const response = await POST(
      createRequest({ action: 'verify', challengeId, response: assertion })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'CHALLENGE_ALREADY_USED' });
  });

  it('refuses when the firewall limiter is unavailable', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false, error: 'blocked' });

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(503);
    expect(mockCreateStepUpOptions).not.toHaveBeenCalled();
  });

  it('rate limits the options action', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    const response = await POST(createRequest({ action: 'options' }));

    expect(response.status).toBe(429);
    expect(mockCreateStepUpOptions).not.toHaveBeenCalled();
  });
});
