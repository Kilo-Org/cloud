import { describe, expect, test } from '@jest/globals';
import {
  freeModelRateLimitIpRedisKey,
  freeModelRateLimitUserRedisKey,
  gitLabOAuthCredentialsRedisKey,
  promotionRateLimitIpRedisKey,
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

  test('separates free model rate limits by subject and limit', () => {
    expect(freeModelRateLimitIpRedisKey('192.0.2.1')).toBe(
      'ai-gateway.free-model-rate-limit:ip:192.0.2.1'
    );
    expect(freeModelRateLimitUserRedisKey('user-123')).toBe(
      'ai-gateway.free-model-rate-limit:user:user-123'
    );
    expect(promotionRateLimitIpRedisKey('192.0.2.1')).toBe(
      'ai-gateway.promotion-rate-limit:ip:192.0.2.1'
    );
  });
});
