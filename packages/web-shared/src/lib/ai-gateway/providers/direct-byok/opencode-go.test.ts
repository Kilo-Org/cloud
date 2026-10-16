import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { applyTrackingIds } from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import type OpenAI from 'openai';
import type { GatewayRequest, OpenRouterChatCompletionRequest } from '../openrouter/types';
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
        disableUrlSuffix: false,
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
      const promptCacheKey = trackedRequest.body.prompt_cache_key;

      openCodeGo.transformRequest(context);

      expect(promptCacheKey).toEqual(expect.any(String));
      expect(context.extraHeaders['x-opencode-session']).toBe(promptCacheKey);
    }
  );

  test('removes user tracking fields from Chat Completions requests', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'qwen3.7-plus', messages: [] },
    };
    const context = createContext({ request });
    applyTrackingIds(request, context.provider, context.kilo_user_id, context.session_id);

    openCodeGo.transformRequest(context);

    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('safety_identifier');
    expect(request.body).not.toHaveProperty('user');
    expect(context.extraHeaders['x-opencode-session']).toEqual(expect.any(String));
  });

  test('removes message names from Chat Completions requests', () => {
    const toolMessageFromClient = {
      role: 'tool',
      name: 'read',
      tool_call_id: 'call-1',
      content: 'ok',
    };
    const body: OpenRouterChatCompletionRequest = {
      model: 'glm-5.3-flash',
      messages: [
        { role: 'user', name: 'alice', content: 'Read a' },
        {
          role: 'assistant',
          name: 'agent',
          content: '',
          tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        },
        toolMessageFromClient as OpenAI.Chat.ChatCompletionToolMessageParam,
      ],
    };

    openCodeGo.transformRequest(createContext({ request: { kind: 'chat_completions', body } }));

    expect(body.messages).toEqual([
      { role: 'user', content: 'Read a' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
    ]);
  });

  test('replaces the OpenRouter reasoning object with reasoning_effort', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'omen-alpha', messages: [], reasoning: { effort: 'high', enabled: true } },
    };

    openCodeGo.transformRequest(createContext({ request }));

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body.reasoning_effort).toBe('high');
  });

  test('keeps an explicit reasoning_effort over the reasoning object', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'omen-alpha',
        messages: [],
        reasoning_effort: 'low',
        reasoning: { effort: 'high' },
      },
    };

    openCodeGo.transformRequest(createContext({ request }));

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body.reasoning_effort).toBe('low');
  });

  test('does not add reasoning_effort when the reasoning object has no effort', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'omen-alpha', messages: [], reasoning: { enabled: true } },
    };

    openCodeGo.transformRequest(createContext({ request }));

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body).not.toHaveProperty('reasoning_effort');
  });

  test('keeps Kimi K3 thinking on when a Messages request disables it', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: { model: 'kimi-k3', messages: [], max_tokens: 100, thinking: { type: 'disabled' } },
    };

    openCodeGo.transformRequest(createContext({ model: 'opencode-go/kimi-k3', request }));

    expect(request.body).not.toHaveProperty('thinking');
  });

  test('keeps the requested Kimi K3 thinking configuration when enabled', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'kimi-k3',
        messages: [],
        max_tokens: 100,
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'max' },
      },
    };

    openCodeGo.transformRequest(createContext({ model: 'opencode-go/kimi-k3', request }));

    expect(request.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(request.body.output_config).toEqual({ effort: 'max' });
  });

  test('keeps disabled thinking for other Messages models', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: { model: 'minimax-m3', messages: [], max_tokens: 100, thinking: { type: 'disabled' } },
    };

    openCodeGo.transformRequest(createContext({ model: 'opencode-go/minimax-m3', request }));

    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });

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
  test.each(['opencode-go/minimax-m3', 'opencode-go/qwen3.7-plus', 'opencode-go/kimi-k3'])(
    'uses the Anthropic Messages API for OpenCode Go model %s',
    model => {
      expect(getAiSdkProvider(model, 'opencode-go')).toBe('anthropic');
    }
  );

  test.each(['opencode-go/kimi-k2.6', 'opencode-go/kimi-k2.7-code', 'opencode-go/kimi-k3-fast'])(
    'uses Chat Completions for OpenCode Go model %s without Messages API support',
    model => {
      expect(getAiSdkProvider(model, 'opencode-go')).toBeUndefined();
    }
  );

  test.each([
    ['moonshotai/kimi-k3', null],
    ['martian/moonshotai/kimi-k3', 'martian'],
  ] as const)('uses Chat Completions for Kimi K3 outside OpenCode Go: %s', (model, provider) => {
    expect(getAiSdkProvider(model, provider)).toBeUndefined();
  });

  test('uses Chat Completions for MiniMax models from other direct providers', () => {
    expect(getAiSdkProvider('minimax/minimax-m2.5', 'chutes-byok')).toBeUndefined();
  });

  test('uses Chat Completions for Morph direct BYOK models', () => {
    expect(getAiSdkProvider('morph/morph-gpt-compatible', 'morph-byok')).toBeUndefined();
  });

  test('uses Chat Completions for MiniMax models through the gateway', () => {
    expect(getAiSdkProvider('minimax/minimax-m2.5', null)).toBeUndefined();
  });
});
