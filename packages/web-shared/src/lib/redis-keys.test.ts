import { describe, expect, test } from '@jest/globals';
import { gitLabOAuthCredentialsRedisKey } from './redis-keys';

describe('Redis key namespaces', () => {
  test('groups GitLab OAuth credentials under auth credentials', () => {
    expect(gitLabOAuthCredentialsRedisKey('ref-123')).toBe('auth-credentials:gitlab:ref-123');
  });
});
