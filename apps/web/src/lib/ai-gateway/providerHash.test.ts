import { OPENROUTER, VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/provider-definitions';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import {
  applyTrackingIds,
  generateOpenRouterDownstreamSafetyIdentifier,
  generateProviderSpecificHash,
  generateProviderSpecificSessionHash,
  generateVercelDownstreamSafetyIdentifier,
} from './providerHash';

describe('generateProviderSpecificHash', () => {
  const testUserId = 'test-user-123';

  it('should generate different hashes for different providers', () => {
    const openRouterHash = generateProviderSpecificHash(testUserId, OPENROUTER);
    const vercelHash = generateProviderSpecificHash(testUserId, VERCEL_AI_GATEWAY);

    expect(openRouterHash).not.toBe(vercelHash);
  });

  it('should generate consistent hashes for the same provider and user', () => {
    const hash1 = generateProviderSpecificHash(testUserId, OPENROUTER);
    const hash2 = generateProviderSpecificHash(testUserId, OPENROUTER);

    expect(hash1).toBe(hash2);
  });

  it('should generate different hashes for different users on the same provider', () => {
    const user1Hash = generateProviderSpecificHash('user1', OPENROUTER);
    const user2Hash = generateProviderSpecificHash('user2', OPENROUTER);

    expect(user1Hash).not.toBe(user2Hash);
  });

  it('should return a base64 encoded string', () => {
    const hash = generateProviderSpecificHash(testUserId, VERCEL_AI_GATEWAY);

    // Base64 pattern check
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('session tracking identifiers', () => {
  const userId = 'oauth/test-user';
  const sessionId = 'conversation-1';

  it('preserves the existing session hash format', () => {
    expect(generateProviderSpecificSessionHash(userId, sessionId, OPENROUTER)).toBe(
      generateProviderSpecificHash(userId + '-' + sessionId, OPENROUTER)
    );
  });

  const requests: GatewayRequest[] = [
    { kind: 'chat_completions', body: { model: 'test-model', messages: [] } },
    { kind: 'messages', body: { model: 'test-model', messages: [], max_tokens: 100 } },
    { kind: 'responses', body: { model: 'test-model', input: 'Hello' } },
  ];

  it.each(requests)('uses the shared session hash for $kind tracking', request => {
    const trackedRequest = structuredClone(request);
    applyTrackingIds(trackedRequest, OPENROUTER, userId, sessionId);

    const trackedSession =
      trackedRequest.kind === 'messages'
        ? trackedRequest.body.session_id
        : trackedRequest.body.prompt_cache_key;
    expect(trackedSession).toBe(generateProviderSpecificSessionHash(userId, sessionId, OPENROUTER));
  });

  it.each(requests)('omits $kind session tracking when the task ID is absent', request => {
    const trackedRequest = structuredClone(request);
    applyTrackingIds(trackedRequest, OPENROUTER, userId, null);

    const trackedSession =
      trackedRequest.kind === 'messages'
        ? trackedRequest.body.session_id
        : trackedRequest.body.prompt_cache_key;
    expect(trackedSession).toBeUndefined();
  });
});

describe('downstream safety identifiers', () => {
  const testUserId = 'test-user-123';

  it('uses the OpenRouter-specific user hash for OpenRouter', () => {
    expect(generateOpenRouterDownstreamSafetyIdentifier(testUserId)).toBe(
      generateProviderSpecificHash(testUserId, OPENROUTER)
    );
  });

  it('keeps OpenRouter and Vercel identifiers distinct', () => {
    expect(generateOpenRouterDownstreamSafetyIdentifier(testUserId)).not.toBe(
      generateVercelDownstreamSafetyIdentifier(testUserId)
    );
  });
});
