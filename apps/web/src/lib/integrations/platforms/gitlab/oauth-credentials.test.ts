import { beforeEach, describe, expect, test } from '@jest/globals';
import { OAUTH_STATE_TTL_SECONDS } from '@/lib/integrations/oauth-state';
import { redisClient } from '@/lib/redis';
import { gitLabOAuthCredentialsRedisKey } from '@/lib/redis-keys';
import { getGitLabOAuthCredentials, storeGitLabOAuthCredentials } from './oauth-credentials';

jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));

const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);

const customCredentials = {
  clientId: 'gitlab-client-id',
  clientSecret: 'gitlab-client-secret',
};

describe('GitLab OAuth credential cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('stores custom credentials in Redis for the OAuth state lifetime', async () => {
    mockedRedisSet.mockResolvedValue('OK');

    const credentialRef = await storeGitLabOAuthCredentials(customCredentials);

    expect(credentialRef).toEqual(expect.any(String));
    if (!credentialRef) throw new Error('Expected cached credential reference');
    expect(mockedRedisSet).toHaveBeenCalledWith(
      gitLabOAuthCredentialsRedisKey(credentialRef),
      JSON.stringify(customCredentials),
      { ex: OAUTH_STATE_TTL_SECONDS + 5 }
    );
  });

  test('returns null when Redis is unavailable for credential storage', async () => {
    mockedRedisSet.mockResolvedValue(null);

    await expect(storeGitLabOAuthCredentials(customCredentials)).resolves.toBeNull();
  });

  test('reads cached custom credentials by opaque reference', async () => {
    mockedRedisGet.mockResolvedValue(JSON.stringify(customCredentials));

    await expect(getGitLabOAuthCredentials('cached-credentials-ref')).resolves.toEqual(
      customCredentials
    );
    expect(mockedRedisGet).toHaveBeenCalledWith(
      gitLabOAuthCredentialsRedisKey('cached-credentials-ref')
    );
  });

  test('rejects malformed cached credentials', async () => {
    mockedRedisGet.mockResolvedValue('{"clientId":"missing-secret"}');

    await expect(getGitLabOAuthCredentials('cached-credentials-ref')).resolves.toBeNull();
  });
});
