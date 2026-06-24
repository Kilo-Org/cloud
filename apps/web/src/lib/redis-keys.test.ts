import { describe, expect, test } from '@jest/globals';
import { gitLabOAuthCredentialsRedisKey, INFERENCE_PROVIDER_USAGE_REDIS_KEY } from './redis-keys';

describe('Redis key namespaces', () => {
  test('groups GitLab OAuth credentials under auth credentials', () => {
    expect(gitLabOAuthCredentialsRedisKey('ref-123')).toBe('auth-credentials:gitlab:ref-123');
  });

  test('groups inference provider usage under the public API namespace', () => {
    expect(INFERENCE_PROVIDER_USAGE_REDIS_KEY).toBe('public-api:inference-provider-usage');
  });
});
