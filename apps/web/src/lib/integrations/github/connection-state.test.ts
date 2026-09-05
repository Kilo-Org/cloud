import { createHash } from 'node:crypto';
import { redisClient } from '@/lib/redis';
import {
  consumeGitHubConnectionOAuthState,
  createGitHubConnectionOAuthState,
} from './connection-state';

jest.mock('@/lib/config.server', () => ({ NEXTAUTH_SECRET: 'connection-state-test-secret' }));
jest.mock('@/lib/redis', () => ({
  redisClient: { set: jest.fn(), getdel: jest.fn() },
}));

const mockedSet = jest.mocked(redisClient.set);
const mockedGetDel = jest.mocked(redisClient.getdel);
const userId = 'oauth/github-connection-user';
const attemptId = '00000000-0000-4000-8000-000000000001';

describe('GitHub connection OAuth state', () => {
  const verifiers = new Map<string, string>();

  beforeEach(() => {
    jest.resetAllMocks();
    verifiers.clear();
    mockedSet.mockImplementation(async (key, value) => {
      if (typeof value !== 'string') throw new Error('Expected string verifier');
      verifiers.set(key, value);
      return 'OK';
    });
    mockedGetDel.mockImplementation(async key => {
      const verifier = verifiers.get(key) ?? null;
      verifiers.delete(key);
      return verifier;
    });
  });

  test.each(['discover', 'confirm'] as const)(
    'round-trips a single-use %s state bound to its attempt and user',
    async stage => {
      const created = await createGitHubConnectionOAuthState({ attemptId, userId, stage });
      const verifier = mockedSet.mock.calls[0]?.[1];
      if (typeof verifier !== 'string') throw new Error('Expected string verifier');
      expect(created.codeChallenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
      await expect(consumeGitHubConnectionOAuthState(created.state, userId)).resolves.toEqual({
        attemptId,
        stage,
        verifierRef: expect.any(String),
        codeVerifier: verifier,
      });
      await expect(consumeGitHubConnectionOAuthState(created.state, userId)).resolves.toBeNull();
    }
  );

  test('does not consume state presented by another Kilo user', async () => {
    const created = await createGitHubConnectionOAuthState({
      attemptId,
      userId,
      stage: 'discover',
    });
    await expect(
      consumeGitHubConnectionOAuthState(created.state, 'oauth/other-user')
    ).resolves.toBeNull();
    expect(mockedGetDel).not.toHaveBeenCalled();
    await expect(consumeGitHubConnectionOAuthState(created.state, userId)).resolves.toMatchObject({
      attemptId,
    });
  });

  test('fails before issuing state when PKCE storage is unavailable', async () => {
    mockedSet.mockResolvedValue(null);
    await expect(
      createGitHubConnectionOAuthState({ attemptId, userId, stage: 'discover' })
    ).rejects.toThrow('configured transient state storage');
  });
});
