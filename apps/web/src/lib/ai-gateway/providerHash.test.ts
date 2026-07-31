import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import {
  applyTrackingIds,
  generateOpenRouterDownstreamSafetyIdentifier,
  generateProviderSpecificHash,
  generateVercelDownstreamSafetyIdentifier,
} from './providerHash';

describe('generateProviderSpecificHash', () => {
  const testUserId = 'test-user-123';

  it('should generate different hashes for different providers', () => {
    const openRouterHash = generateProviderSpecificHash(testUserId, PROVIDERS.OPENROUTER);
    const vercelHash = generateProviderSpecificHash(testUserId, PROVIDERS.VERCEL_AI_GATEWAY);

    expect(openRouterHash).not.toBe(vercelHash);
  });

  it('should generate consistent hashes for the same provider and user', () => {
    const hash1 = generateProviderSpecificHash(testUserId, PROVIDERS.OPENROUTER);
    const hash2 = generateProviderSpecificHash(testUserId, PROVIDERS.OPENROUTER);

    expect(hash1).toBe(hash2);
  });

  it('should generate different hashes for different users on the same provider', () => {
    const user1Hash = generateProviderSpecificHash('user1', PROVIDERS.OPENROUTER);
    const user2Hash = generateProviderSpecificHash('user2', PROVIDERS.OPENROUTER);

    expect(user1Hash).not.toBe(user2Hash);
  });

  it('should return a base64 encoded string', () => {
    const hash = generateProviderSpecificHash(testUserId, PROVIDERS.VERCEL_AI_GATEWAY);

    // Base64 pattern check
    expect(hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe('downstream safety identifiers', () => {
  const testUserId = 'test-user-123';

  it('uses the OpenRouter-specific user hash for OpenRouter', () => {
    expect(generateOpenRouterDownstreamSafetyIdentifier(testUserId)).toBe(
      generateProviderSpecificHash(testUserId, PROVIDERS.OPENROUTER)
    );
  });

  it('keeps OpenRouter and Vercel identifiers distinct', () => {
    expect(generateOpenRouterDownstreamSafetyIdentifier(testUserId)).not.toBe(
      generateVercelDownstreamSafetyIdentifier(testUserId)
    );
  });
});

describe('applyTrackingIds', () => {
  const userId = 'user-123';
  const taskId = 'task-456';
  const taskHash = generateProviderSpecificHash(`${userId}-${taskId}`, PROVIDERS.OPENROUTER);

  function responsesRequest(body: Partial<GatewayResponsesRequest> = {}) {
    const fullBody: GatewayResponsesRequest = {
      model: 'openai/gpt-5.4',
      input: 'hi',
      ...body,
    };
    const request: GatewayRequest = { kind: 'responses', body: fullBody };
    return { request, body: fullBody };
  }

  function messagesRequest(body: Partial<GatewayMessagesRequest> = {}) {
    const fullBody: GatewayMessagesRequest = {
      model: 'anthropic/claude-sonnet-4.5',
      max_tokens: 1024,
      messages: [],
      ...body,
    };
    const request: GatewayRequest = { kind: 'messages', body: fullBody };
    return { request, body: fullBody };
  }

  it('sets prompt_cache_key to the task hash when the client did not set one', () => {
    const { request, body } = responsesRequest();
    applyTrackingIds(request, PROVIDERS.OPENROUTER, userId, taskId);
    expect(body.prompt_cache_key).toBe(taskHash);
  });

  it('does not overwrite a client-supplied prompt_cache_key', () => {
    const clientKey = '019fb418-bf88-70cc-bb8c-f595c82173b3';
    const { request, body } = responsesRequest({ prompt_cache_key: clientKey });
    applyTrackingIds(request, PROVIDERS.OPENROUTER, userId, taskId);
    expect(body.prompt_cache_key).toBe(clientKey);
  });

  it('does not overwrite a client-supplied prompt_cache_key on chat completions', () => {
    const clientKey = 'client-cache-key';
    const body = {
      model: 'openai/gpt-5.4',
      messages: [],
      prompt_cache_key: clientKey,
    };
    const request: GatewayRequest = { kind: 'chat_completions', body };
    applyTrackingIds(request, PROVIDERS.OPENROUTER, userId, taskId);
    expect(body.prompt_cache_key).toBe(clientKey);
  });

  it('leaves prompt_cache_key unset when there is no task id', () => {
    const { request, body } = responsesRequest();
    applyTrackingIds(request, PROVIDERS.OPENROUTER, userId, null);
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('sets session_id to the task hash when the client did not set one', () => {
    const { request, body } = messagesRequest();
    applyTrackingIds(request, PROVIDERS.OPENROUTER, userId, taskId);
    expect(body.session_id).toBe(taskHash);
  });

  it('does not overwrite a client-supplied session_id', () => {
    const clientSessionId = 'client-session-id';
    const { request, body } = messagesRequest({ session_id: clientSessionId });
    applyTrackingIds(request, PROVIDERS.OPENROUTER, userId, taskId);
    expect(body.session_id).toBe(clientSessionId);
  });
});
