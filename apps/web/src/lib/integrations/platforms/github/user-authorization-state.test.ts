import { createHash } from 'node:crypto';
import { redisClient } from '@/lib/redis';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import {
  consumeGitHubUserAuthorizationState,
  createGitHubUserAuthorizationState,
} from './user-authorization-state';

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'synthetic-oauth-signing-secret' }));
jest.mock('@/lib/redis', () => ({
  redisClient: { set: jest.fn(), getdel: jest.fn() },
}));

const mockedRedisGetDel = jest.mocked(redisClient.getdel);
const mockedRedisSet = jest.mocked(redisClient.set);
const userId = 'oauth/synthetic-user';

function stateWithPayload(payload: string): string {
  return createOAuthState(
    `github-user-authorization:${Buffer.from(payload).toString('base64url')}`,
    userId
  );
}

describe('GitHub user authorization state', () => {
  const verifiers = new Map<string, string>();

  beforeEach(() => {
    jest.resetAllMocks();
    verifiers.clear();
    mockedRedisSet.mockImplementation(async (key, value) => {
      if (typeof value !== 'string') throw new Error('Expected a string verifier');
      verifiers.set(key, value);
      return 'OK';
    });
    mockedRedisGetDel.mockImplementation(async key => {
      const value = verifiers.get(key) ?? null;
      verifiers.delete(key);
      return value;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('round-trips a single-use PKCE verifier bound to a non-UUID Kilo user', async () => {
    const created = await createGitHubUserAuthorizationState(userId);
    const codeVerifier = mockedRedisSet.mock.calls[0][1];
    if (typeof codeVerifier !== 'string') throw new Error('Expected a string verifier');

    expect(created.codeChallenge).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url')
    );
    expect(mockedRedisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^auth-pkce:github-user:/),
      codeVerifier,
      { ex: 605 }
    );
    await expect(consumeGitHubUserAuthorizationState(created.state, userId)).resolves.toEqual({
      status: 'consumed',
      codeVerifier,
    });
    expect(mockedRedisGetDel).toHaveBeenCalledWith(mockedRedisSet.mock.calls[0][0]);
    await expect(consumeGitHubUserAuthorizationState(created.state, userId)).resolves.toEqual({
      status: 'invalid',
      reason: 'verifier_missing',
    });
  });

  test('does not consume a verifier for a different signed-in user', async () => {
    const created = await createGitHubUserAuthorizationState(userId);
    await expect(
      consumeGitHubUserAuthorizationState(created.state, 'oauth/synthetic-other')
    ).resolves.toEqual({
      status: 'invalid',
      reason: 'user_mismatch',
    });
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
    await expect(consumeGitHubUserAuthorizationState(created.state, userId)).resolves.toMatchObject(
      { status: 'consumed' }
    );
  });

  test('validates the flow before touching storage', async () => {
    await expect(
      consumeGitHubUserAuthorizationState(createOAuthState('other-flow', userId), userId)
    ).resolves.toEqual({
      status: 'invalid',
      reason: 'flow_mismatch',
    });
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
  });

  test.each(['not-json', 'null', '{}', '{"verifierRef":""}', '{"verifierRef":1}'])(
    'classifies invalid reference payload without touching storage: %s',
    async payload => {
      await expect(
        consumeGitHubUserAuthorizationState(stateWithPayload(payload), userId)
      ).resolves.toEqual({
        status: 'invalid',
        reason: 'payload_invalid',
      });
      expect(mockedRedisGetDel).not.toHaveBeenCalled();
    }
  );

  test.each([
    [null, 'state_missing'],
    ['malformed', 'state_malformed'],
    ['payload.signature', 'signature_invalid'],
  ])('does not consume storage for invalid signed state: %s', async (state, reason) => {
    await expect(consumeGitHubUserAuthorizationState(state, userId)).resolves.toEqual({
      status: 'invalid',
      reason,
    });
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
  });

  test('rejects expired state before storage access', async () => {
    jest.useFakeTimers();
    const created = await createGitHubUserAuthorizationState(userId);
    jest.advanceTimersByTime(601_000);
    await expect(consumeGitHubUserAuthorizationState(created.state, userId)).resolves.toEqual({
      status: 'invalid',
      reason: 'state_expired',
    });
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
  });

  test('keeps independently started same-account flows independent', async () => {
    const first = await createGitHubUserAuthorizationState(userId);
    const second = await createGitHubUserAuthorizationState(userId);
    expect(first.state).not.toBe(second.state);
    expect(mockedRedisSet.mock.calls[0][0]).not.toBe(mockedRedisSet.mock.calls[1][0]);
    const results = await Promise.all([
      consumeGitHubUserAuthorizationState(second.state, userId),
      consumeGitHubUserAuthorizationState(first.state, userId),
    ]);
    expect(results).toEqual([
      { status: 'consumed', codeVerifier: mockedRedisSet.mock.calls[1][1] },
      { status: 'consumed', codeVerifier: mockedRedisSet.mock.calls[0][1] },
    ]);
  });

  test('consumes one state exactly once under concurrent callbacks', async () => {
    const created = await createGitHubUserAuthorizationState(userId);
    const results = await Promise.all([
      consumeGitHubUserAuthorizationState(created.state, userId),
      consumeGitHubUserAuthorizationState(created.state, userId),
    ]);
    expect(results.filter(result => result.status === 'consumed')).toHaveLength(1);
    expect(results.filter(result => result.status === 'invalid')).toEqual([
      { status: 'invalid', reason: 'verifier_missing' },
    ]);
  });

  test.each([
    new DOMException('synthetic-sensitive-timeout', 'TimeoutError'),
    new Error('synthetic-sensitive-storage-failure'),
  ])('classifies storage exceptions without exposing or retrying them', async error => {
    const created = await createGitHubUserAuthorizationState(userId);
    mockedRedisGetDel.mockRejectedValueOnce(error);
    await expect(consumeGitHubUserAuthorizationState(created.state, userId)).resolves.toEqual({
      status: 'storage_error',
      reason: 'storage_unavailable',
    });
    expect(mockedRedisGetDel).toHaveBeenCalledTimes(1);
  });

  test('classifies an absent verifier without claiming expiration or replay', async () => {
    const created = await createGitHubUserAuthorizationState(userId);
    verifiers.clear();
    await expect(consumeGitHubUserAuthorizationState(created.state, userId)).resolves.toEqual({
      status: 'invalid',
      reason: 'verifier_missing',
    });
  });

  test('fails closed if transient PKCE storage is unavailable', async () => {
    mockedRedisSet.mockResolvedValue(null);
    await expect(createGitHubUserAuthorizationState(userId)).rejects.toThrow(
      'configured transient state storage'
    );
  });

  test('does not return authorization state after a failed storage write', async () => {
    mockedRedisSet.mockRejectedValueOnce(new Error('synthetic-write-failed'));
    await expect(createGitHubUserAuthorizationState(userId)).rejects.toThrow(
      'synthetic-write-failed'
    );
  });
});
