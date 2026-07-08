import { describe, expect, test } from '@jest/globals';
import { gitLabOAuthCredentialsRedisKey, vercelInferenceProvidersRedisKey } from './redis-keys';

describe('Redis key namespaces', () => {
  test('groups GitLab OAuth credentials under auth credentials', () => {
    expect(gitLabOAuthCredentialsRedisKey('ref-123')).toBe('auth-credentials:gitlab:ref-123');
  });

  test('creates a separate Vercel inference provider key per model', () => {
    expect(vercelInferenceProvidersRedisKey('anthropic/claude-sonnet-4.5')).toBe(
      'ai-gateway.metadata:vercel-inference-providers:anthropic/claude-sonnet-4.5'
    );
  });
});
