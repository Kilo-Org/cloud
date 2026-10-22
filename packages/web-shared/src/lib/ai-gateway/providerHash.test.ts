import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
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

describe('deployment pseudonym key', () => {
  const testUserId = 'test-user-123';

  /**
   * Replaces `process.env` for the rest of the test, dropping the deployment
   * key and the Vercel environment unless the test sets them. Restored by
   * `afterEach`.
   */
  function useEnv(overrides: {
    NODE_ENV?: NodeJS.ProcessEnv['NODE_ENV'];
    VERCEL_ENV?: string;
    AI_GATEWAY_PSEUDONYM_KEY?: string;
  }) {
    jest.restoreAllMocks();
    const nextEnv = { ...process.env, ...overrides };
    for (const name of ['AI_GATEWAY_PSEUDONYM_KEY', 'VERCEL_ENV'] as const) {
      if (!(name in overrides)) delete nextEnv[name];
    }
    return jest.replaceProperty(process, 'env', nextEnv as NodeJS.ProcessEnv);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates different pseudonyms for the same user under different deployment keys', () => {
    useEnv({ AI_GATEWAY_PSEUDONYM_KEY: 'first-deployment-key' });
    const firstKeyHash = generateProviderSpecificHash(testUserId, OPENROUTER);

    useEnv({ AI_GATEWAY_PSEUDONYM_KEY: 'second-deployment-key' });
    const secondKeyHash = generateProviderSpecificHash(testUserId, OPENROUTER);

    expect(firstKeyHash).not.toBe(secondKeyHash);
  });

  it('refuses to pseudonymize in production without the deployment key', () => {
    useEnv({ NODE_ENV: 'production', VERCEL_ENV: 'production' });

    expect(() => generateProviderSpecificHash(testUserId, OPENROUTER)).toThrow(
      /Missing required environment variable AI_GATEWAY_PSEUDONYM_KEY/
    );
  });

  it('keys the non-production fallback on a preview deployment that has no deployment key', () => {
    useEnv({ NODE_ENV: 'test' });
    const fallbackHash = generateProviderSpecificHash(testUserId, OPENROUTER);

    useEnv({ NODE_ENV: 'production', VERCEL_ENV: 'preview' });

    expect(generateProviderSpecificHash(testUserId, OPENROUTER)).toBe(fallbackHash);
  });

  it('keys a non-production fallback that differs from a configured deployment key', () => {
    useEnv({ NODE_ENV: 'test' });
    const fallbackHash = generateProviderSpecificHash(testUserId, OPENROUTER);

    useEnv({ AI_GATEWAY_PSEUDONYM_KEY: 'configured-deployment-key' });

    expect(generateProviderSpecificHash(testUserId, OPENROUTER)).not.toBe(fallbackHash);
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

  it.each(requests)('uses the shared session hash for Vercel $kind tracking', request => {
    const trackedRequest = structuredClone(request);
    applyTrackingIds(trackedRequest, VERCEL_AI_GATEWAY, userId, sessionId);

    const trackedSession =
      trackedRequest.kind === 'messages'
        ? trackedRequest.body.session_id
        : trackedRequest.body.prompt_cache_key;
    expect(trackedSession).toBe(
      generateProviderSpecificSessionHash(userId, sessionId, VERCEL_AI_GATEWAY)
    );
  });

  it('sets the Vercel user hash on Vercel messages requests', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: { model: 'test-model', messages: [], max_tokens: 100 },
    };
    applyTrackingIds(request, VERCEL_AI_GATEWAY, userId, null);

    expect(request.body).toHaveProperty('user', generateVercelDownstreamSafetyIdentifier(userId));
    expect(request.body).not.toHaveProperty('session_id');
  });

  const promptCacheKeyRequests = (promptCacheKey: string): GatewayRequest[] => [
    {
      kind: 'chat_completions',
      body: { model: 'test-model', messages: [], prompt_cache_key: promptCacheKey },
    },
    {
      kind: 'responses',
      body: { model: 'test-model', input: 'Hello', prompt_cache_key: promptCacheKey },
    },
  ];

  it.each(promptCacheKeyRequests('k'.repeat(64)))(
    'keeps a client $kind prompt cache key within the length limit',
    request => {
      applyTrackingIds(request, OPENROUTER, userId, null);

      expect(request.body).toHaveProperty('prompt_cache_key', 'k'.repeat(64));
    }
  );

  it.each(promptCacheKeyRequests('k'.repeat(65)))(
    'hashes a client $kind prompt cache key over the length limit',
    request => {
      applyTrackingIds(request, OPENROUTER, userId, null);

      expect(request.body).toHaveProperty(
        'prompt_cache_key',
        generateProviderSpecificSessionHash(userId, 'k'.repeat(65), OPENROUTER)
      );
    }
  );

  it.each(promptCacheKeyRequests('k'.repeat(65)))(
    'prefers the task session hash over a long client $kind prompt cache key',
    request => {
      applyTrackingIds(request, OPENROUTER, userId, sessionId);

      expect(request.body).toHaveProperty(
        'prompt_cache_key',
        generateProviderSpecificSessionHash(userId, sessionId, OPENROUTER)
      );
    }
  );
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
