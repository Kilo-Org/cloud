import { createHash } from 'node:crypto';
import { redisGetDel, redisSet } from '@/lib/redis';
import {
  consumeGitHubUserAuthorizationState,
  createGitHubUserAuthorizationState,
} from './user-authorization-state';

jest.mock('@/lib/redis', () => ({
  redisGetDel: jest.fn(),
  redisSet: jest.fn(),
}));

const mockedRedisGetDel = jest.mocked(redisGetDel);
const mockedRedisSet = jest.mocked(redisSet);

describe('GitHub user authorization state', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRedisSet.mockResolvedValue(true);
  });

  test('round-trips a single-use PKCE verifier bound to the Kilo user', async () => {
    const created = await createGitHubUserAuthorizationState('user_123');
    const codeVerifier = mockedRedisSet.mock.calls[0][1];
    mockedRedisGetDel.mockResolvedValueOnce(codeVerifier).mockResolvedValueOnce(null);

    expect(created.codeChallenge).toBe(
      createHash('sha256').update(codeVerifier).digest('base64url')
    );
    await expect(consumeGitHubUserAuthorizationState(created.state, 'user_123')).resolves.toEqual({
      codeVerifier,
    });
    await expect(
      consumeGitHubUserAuthorizationState(created.state, 'user_123')
    ).resolves.toBeNull();
  });

  test('does not consume a verifier for a different signed-in user', async () => {
    const created = await createGitHubUserAuthorizationState('user_owner');

    await expect(
      consumeGitHubUserAuthorizationState(created.state, 'user_other')
    ).resolves.toBeNull();
    expect(mockedRedisGetDel).not.toHaveBeenCalled();
  });

  test('fails closed if transient PKCE storage is unavailable', async () => {
    mockedRedisSet.mockResolvedValue(false);

    await expect(createGitHubUserAuthorizationState('user_123')).rejects.toThrow(
      'configured transient state storage'
    );
  });
});
