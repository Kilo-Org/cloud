import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getUserFromAuth } from '@/lib/user/server';
import { redisClient } from '@/lib/redis';
import { createGitHubUserAuthorizationState } from '@/lib/integrations/platforms/github/user-authorization-state';
import { exchangeAndStoreGitHubUserAuthorization } from '@/lib/integrations/platforms/github/user-authorization';
import { GET } from './route';

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'synthetic-oauth-signing-secret' }));
jest.mock('@/lib/constants', () => ({ APP_URL: 'https://app.example.test' }));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/redis', () => ({ redisClient: { set: jest.fn(), getdel: jest.fn() } }));
jest.mock('@/lib/integrations/platforms/github/user-authorization', () => ({
  exchangeAndStoreGitHubUserAuthorization: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn(), captureMessage: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedExchange = jest.mocked(exchangeAndStoreGitHubUserAuthorization);
const mockedRedisGetDel = jest.mocked(redisClient.getdel);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedCaptureMessage = jest.mocked(captureMessage);
const mockedCaptureException = jest.mocked(captureException);
const userId = 'oauth/synthetic-callback-user';
const code = 'synthetic-code';

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('/api/integrations/github/user-connect/callback', 'https://app.example.test');
  url.search = new URLSearchParams(params).toString();
  return new NextRequest(url);
}

function expectRedirect(response: Response, key: 'error' | 'success', value: string) {
  expect(response.status).toBe(307);
  const url = new URL(response.headers.get('location') ?? '');
  expect(url.origin).toBe('https://app.example.test');
  expect(url.pathname).toBe('/integrations/github');
  expect(Object.fromEntries(url.searchParams)).toEqual({ [key]: value, flow: 'user-connect' });
}

describe('GET /api/integrations/github/user-connect/callback', () => {
  const verifiers = new Map<string, string>();

  beforeEach(() => {
    jest.resetAllMocks();
    verifiers.clear();
    mockedGetUserFromAuth.mockResolvedValue({
      user: { id: userId },
      authFailedResponse: null,
    } as Awaited<ReturnType<typeof getUserFromAuth>>);
    mockedRedisSet.mockImplementation(async (key, value) => {
      if (typeof value !== 'string') throw new Error('Expected a string verifier');
      verifiers.set(key, value);
      return 'OK';
    });
    mockedRedisGetDel.mockImplementation(async key => {
      const verifier = verifiers.get(key) ?? null;
      verifiers.delete(key);
      return verifier;
    });
    mockedExchange.mockResolvedValue({ status: 'connected', githubLogin: 'synthetic-login' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('redirects an unauthenticated callback before state consumption', async () => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      ),
    });
    const response = await GET(makeRequest({ code, state }));
    expect(response.headers.get('location')).toBe('https://app.example.test/users/sign_in');
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
  });

  test('handles provider cancellation without consuming or logging provider data', async () => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    expectRedirect(
      await GET(makeRequest({ code, state, error: 'synthetic-sensitive-provider-error' })),
      'error',
      'authorization_cancelled'
    );
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).not.toHaveBeenCalled();
    expect(mockedCaptureException).not.toHaveBeenCalled();
  });

  test.each([undefined, '', 'invalid code', 'x'.repeat(2049)])(
    'leaves the verifier available after a missing or malformed code (case %#)',
    async invalidCode => {
      const { state } = await createGitHubUserAuthorizationState(userId);
      const params: Record<string, string> = { state };
      if (invalidCode !== undefined) params.code = invalidCode;
      expectRedirect(await GET(makeRequest(params)), 'error', 'missing_code');
      expect(mockedRedisGetDel).not.toHaveBeenCalled();
      expect(mockedExchange).not.toHaveBeenCalled();
      expect(mockedCaptureMessage).not.toHaveBeenCalled();
      expectRedirect(await GET(makeRequest({ code, state })), 'success', 'user_connected');
      expect(mockedExchange).toHaveBeenCalledWith({
        kiloUserId: userId,
        code,
        codeVerifier: mockedRedisSet.mock.calls[0][1],
      });
    }
  );

  test('rejects missing state even when a code is present', async () => {
    expectRedirect(await GET(makeRequest({ code })), 'error', 'invalid_state');
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'GitHub user authorization callback invalid state',
      {
        level: 'warning',
        tags: {
          endpoint: 'github/user-connect/callback',
          stage: 'consume_state',
          reason: 'state_missing',
        },
        extra: { hasCode: true, hasState: false, stateHash: null, hasProviderError: false },
      }
    );
  });

  test('rejects tampered state without consuming or exchanging', async () => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    expectRedirect(
      await GET(makeRequest({ code, state: `${state}tampered` })),
      'error',
      'invalid_state'
    );
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'signature_invalid' }) })
    );
  });

  test('rejects expired state before consuming storage', async () => {
    jest.useFakeTimers();
    const { state } = await createGitHubUserAuthorizationState(userId);
    jest.advanceTimersByTime(601_000);
    expectRedirect(await GET(makeRequest({ code, state })), 'error', 'invalid_state');
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'state_expired' }) })
    );
  });

  test('routes a different authenticated account to account-mismatch recovery', async () => {
    const { state } = await createGitHubUserAuthorizationState('oauth/synthetic-other-account');
    expectRedirect(await GET(makeRequest({ code, state })), 'error', 'account_mismatch');
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: expect.objectContaining({ reason: 'user_mismatch' }) })
    );
  });

  test('classifies missing verifier separately from storage failures', async () => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    verifiers.clear();
    expectRedirect(await GET(makeRequest({ code, state })), 'error', 'invalid_state');
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'GitHub user authorization callback invalid state',
      {
        level: 'warning',
        tags: {
          endpoint: 'github/user-connect/callback',
          stage: 'consume_state',
          reason: 'verifier_missing',
        },
        extra: {
          hasCode: true,
          hasState: true,
          stateHash: createHash('sha256').update(state).digest('hex').slice(0, 8),
          hasProviderError: false,
        },
      }
    );
  });

  test.each([
    new DOMException('synthetic-sensitive-timeout', 'TimeoutError'),
    new Error('synthetic-sensitive-redis-details'),
  ])('reports a storage failure safely without exchange or GETDEL retry', async error => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    const verifier = mockedRedisSet.mock.calls[0][1];
    mockedRedisGetDel.mockRejectedValueOnce(error);
    expectRedirect(await GET(makeRequest({ code, state })), 'error', 'connection_failed');
    expect(mockedRedisGetDel).toHaveBeenCalledTimes(1);
    expect(mockedExchange).not.toHaveBeenCalled();
    expect(mockedCaptureException).not.toHaveBeenCalled();
    expect(mockedCaptureMessage).toHaveBeenCalledTimes(1);
    expect(mockedCaptureMessage).toHaveBeenCalledWith(
      'GitHub user authorization callback storage failure',
      {
        level: 'error',
        tags: {
          endpoint: 'github/user-connect/callback',
          stage: 'consume_state',
          reason: 'storage_unavailable',
        },
        extra: {
          hasCode: true,
          hasState: true,
          stateHash: createHash('sha256').update(state).digest('hex').slice(0, 8),
          hasProviderError: false,
        },
      }
    );
    const telemetry = JSON.stringify(mockedCaptureMessage.mock.calls);
    for (const sensitive of [code, state, verifier, userId, error.message]) {
      expect(telemetry).not.toContain(sensitive);
    }
  });

  test('exchanges a valid callback exactly once under concurrent requests', async () => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    const results = await Promise.all([
      GET(makeRequest({ code, state })),
      GET(makeRequest({ code, state })),
    ]);
    expectRedirect(results[0], 'success', 'user_connected');
    expectRedirect(results[1], 'error', 'invalid_state');
    expect(mockedExchange).toHaveBeenCalledTimes(1);
    expect(mockedExchange).toHaveBeenCalledWith({
      kiloUserId: userId,
      code,
      codeVerifier: mockedRedisSet.mock.calls[0][1],
    });
  });

  test.each([
    'already_connected_to_another_account',
    'disconnect_existing_identity_first',
  ] as const)('preserves authorization conflict redirects: %s', async status => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    mockedExchange.mockResolvedValueOnce({ status });
    expectRedirect(await GET(makeRequest({ code, state })), 'error', status);
  });

  test('sanitizes unexpected exchange errors and records the stage', async () => {
    const { state } = await createGitHubUserAuthorizationState(userId);
    const sensitiveError = `synthetic-exchange-secret ${code} ${state} ${userId}`;
    mockedExchange.mockRejectedValueOnce(new Error(sensitiveError));
    expectRedirect(await GET(makeRequest({ code, state })), 'error', 'connection_failed');
    expect(mockedCaptureException).toHaveBeenCalledWith(
      new Error('GitHub user authorization callback failed'),
      {
        tags: {
          endpoint: 'github/user-connect/callback',
          stage: 'exchange_and_store_authorization',
          reason: 'operation_failed',
        },
        extra: {
          hasCode: true,
          hasState: true,
          stateHash: createHash('sha256').update(state).digest('hex').slice(0, 8),
          hasProviderError: false,
        },
      }
    );
    const telemetry = JSON.stringify(mockedCaptureException.mock.calls, (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value
    );
    for (const sensitive of [
      sensitiveError,
      code,
      state,
      userId,
      mockedRedisSet.mock.calls[0][1],
    ]) {
      expect(telemetry).not.toContain(sensitive);
    }
  });
});
