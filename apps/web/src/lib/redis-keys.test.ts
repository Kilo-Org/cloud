import { describe, expect, test } from '@jest/globals';
import {
  gitLabOAuthCredentialsRedisKey,
  REQUEST_LOGGING_OPT_INS_REDIS_KEY,
  vercelInferenceProvidersRedisKey,
} from './redis-keys';

describe('Redis key namespaces', () => {
  test('groups GitLab OAuth credentials under auth credentials', () => {
    expect(gitLabOAuthCredentialsRedisKey('ref-123')).toBe('auth-credentials:gitlab:ref-123');
  });

  test('creates a separate Vercel inference provider key per model', () => {
    expect(vercelInferenceProvidersRedisKey('anthropic/claude-sonnet-4.5')).toBe(
      'ai-gateway.metadata:vercel-inference-providers:anthropic/claude-sonnet-4.5'
    );
  });

  test('uses one key for the request logging opt-in array', () => {
    expect(REQUEST_LOGGING_OPT_INS_REDIS_KEY).toBe('ai-gateway:request-logging-opt-ins');
  });
});
