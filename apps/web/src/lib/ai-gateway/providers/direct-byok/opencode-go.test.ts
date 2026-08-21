import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import { applyTrackingIds } from '@/lib/ai-gateway/providerHash';
import type { GatewayRequest } from '../openrouter/types';
import type { TransformRequestContext } from '../types';
import { getAiSdkProvider } from '../model-settings';
import openCodeGo from './opencode-go';

test('allows the Responses API for OpenCode Go', () => {
  expect(openCodeGo.supported_chat_apis).toContain('responses');
});

describe('OpenCode Go session headers', () => {
  const requests: GatewayRequest[] = [
    { kind: 'chat_completions', body: { model: 'qwen3.7-plus', messages: [] } },
    { kind: 'messages', body: { model: 'qwen3.7-plus', messages: [], max_tokens: 100 } },
    { kind: 'responses', body: { model: 'qwen3.7-plus', input: 'Hello' } },
  ];

  function createContext(
    overrides: Partial<TransformRequestContext> = {}
  ): TransformRequestContext {
    return {
      provider: {
        id: 'direct-byok',
        apiUrl: openCodeGo.base_url,
        apiUrlOverrides: {},
        apiKey: 'test-api-key',
        apiKeyHeader: null,
        supportedChatApis: openCodeGo.supported_chat_apis,
        responseTransforms: null,
        async transformRequest() {},
      },
      model: 'opencode-go/qwen3.7-plus',
      request: requests[0],
      originalHeaders: EmptyFraudDetectionHeaders,
      extraHeaders: {},
      userByok: null,
      kilo_user_id: 'oauth/test-user',
      organization_id: null,
      session_id: 'conversation-1',
      ...overrides,
    };
  }

  test.each(requests)('adds a stable conversation header for $kind', request => {
    const first = createContext({ request });
    const next = createContext({ request });
    const otherApi = createContext();

    openCodeGo.transformRequest(first);
    openCodeGo.transformRequest(next);
    openCodeGo.transformRequest(otherApi);

    const session = first.extraHeaders['x-opencode-session'];
    expect(session).toEqual(expect.any(String));
    expect(session).not.toBe('');
    expect(session).not.toContain(first.kilo_user_id);
    expect(next.extraHeaders['x-opencode-session']).toBe(session);
    expect(otherApi.extraHeaders['x-opencode-session']).toBe(session);
    expect(first.extraHeaders['x-api-key']).toBe(
      request.kind === 'messages' ? 'test-api-key' : undefined
    );
    expect(first.provider.apiKeyHeader).toBeNull();
  });

  test.each([{ session_id: 'conversation-2' }, { kilo_user_id: 'oauth/another-user' }])(
    'isolates sessions when the conversation or user changes: %j',
    overrides => {
      const first = createContext();
      const other = createContext(overrides);

      openCodeGo.transformRequest(first);
      openCodeGo.transformRequest(other);

      expect(other.extraHeaders['x-opencode-session']).not.toBe(
        first.extraHeaders['x-opencode-session']
      );
    }
  );

  test.each(requests.filter(request => request.kind !== 'messages'))(
    'matches the existing prompt cache key for $kind',
    request => {
      const trackedRequest = structuredClone(request);
      const context = createContext({ request: trackedRequest });
      applyTrackingIds(trackedRequest, context.provider, context.kilo_user_id, context.session_id);

      openCodeGo.transformRequest(context);

      expect(context.extraHeaders['x-opencode-session']).toBe(trackedRequest.body.prompt_cache_key);
    }
  );

  test('keeps the header stable when the model, API key, or request body changes', () => {
    const first = createContext();
    const next = createContext({
      model: 'opencode-go/minimax-m3',
      request: { kind: 'responses', body: { model: 'minimax-m3', input: 'Next turn' } },
      provider: { ...first.provider, apiKey: 'rotated-key' },
    });

    openCodeGo.transformRequest(first);
    openCodeGo.transformRequest(next);

    expect(next.extraHeaders['x-opencode-session']).toBe(first.extraHeaders['x-opencode-session']);
  });

  test('assigns isolated fallback headers when no conversation identifier is available', () => {
    const first = createContext({ session_id: null });
    const second = createContext({ session_id: null });

    openCodeGo.transformRequest(first);
    openCodeGo.transformRequest(second);

    expect(first.extraHeaders['x-opencode-session']).toEqual(expect.any(String));
    expect(first.extraHeaders['x-opencode-session']).not.toBe('');
    expect(second.extraHeaders['x-opencode-session']).not.toBe(
      first.extraHeaders['x-opencode-session']
    );
  });
});

describe('getAiSdkProvider', () => {
  test.each(['opencode-go/minimax-m3', 'opencode-go/qwen3.7-plus'])(
    'uses the Anthropic Messages API for OpenCode Go model %s',
    model => {
      expect(getAiSdkProvider(model, 'opencode-go')).toBe('anthropic');
    }
  );

  test('uses Chat Completions for MiniMax models from other direct providers', () => {
    expect(getAiSdkProvider('minimax/minimax-m2.5', 'crofai')).toBeUndefined();
  });

  test('uses OpenAI-compatible Chat Completions for Morph direct BYOK models', () => {
    expect(getAiSdkProvider('morph/morph-gpt-compatible', 'morph-byok')).toBe('openai-compatible');
  });

  test('uses Chat Completions for MiniMax models through the gateway', () => {
    expect(getAiSdkProvider('minimax/minimax-m2.5', null)).toBeUndefined();
  });
});
