import { describe, expect, it } from '@jest/globals';
import { CustomLlmApiConfigSchema, type CustomLlmApiConfig } from '@kilocode/db';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { applyReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import {
  applyTrackingIds,
  generateProviderSpecificHash,
} from '@kilocode/web-shared/lib/ai-gateway/providerHash';
import { buildDirectProvider, type DirectUpstreamAuth } from './build-direct-provider';

type ChatCompletionRequest = Extract<GatewayRequest, { kind: 'chat_completions' }>;

const API_KEY_AUTH: DirectUpstreamAuth = {
  type: 'api_key',
  apiKey: 'test-key',
  apiKeyHeader: null,
};

async function transformRequest(
  request: GatewayRequest,
  options: Partial<Omit<CustomLlmApiConfig, 'base_url'>> = {},
  kilo_user_id = 'user-1',
  session_id: string | null = null
) {
  const provider = buildDirectProvider(
    'custom',
    ['chat_completions'],
    {
      internal_id: 'upstream-model',
      base_url: 'https://llm.example.com/v1',
      ...options,
    },
    API_KEY_AUTH
  );

  const extraHeaders: Record<string, string> = {};
  await provider.transformRequest({
    provider,
    model: 'public-model',
    request,
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders,
    userByok: null,
    kilo_user_id,
    organization_id: null,
    session_id,
  });
  applyReasoningDetailsTransform(provider, request);
  return extraHeaders;
}

function makeRequest(): ChatCompletionRequest {
  const toolCall = {
    id: 'call-1',
    type: 'function' as const,
    function: { name: 'lookup', arguments: '{}' },
  };
  const toolMessage = {
    role: 'tool' as const,
    content: 'result',
    tool_call_id: 'call-1',
  };
  const assistantMessage = {
    role: 'assistant' as const,
    content: null,
    tool_calls: [toolCall],
  };
  Object.assign(assistantMessage, {
    reasoning_details: [
      {
        type: 'reasoning.encrypted' as const,
        data: 'assistant-signature',
        id: 'call-1',
        index: 0,
        format: 'google-gemini-v1' as const,
      },
    ],
  });
  const request: ChatCompletionRequest = {
    kind: 'chat_completions',
    body: {
      model: 'public-model',
      stream: false,
      messages: [assistantMessage, toolMessage],
    },
  };

  Object.assign(toolCall, { extra_content: { trace_id: 'trace-1' } });

  return request;
}

describe('custom LLM endpoint configuration', () => {
  it('accepts an exact endpoint without an internal model ID', () => {
    const config = {
      base_url: 'https://llm.example.com/deployments/my-model/invoke',
      disable_url_suffix: true,
    };

    expect(CustomLlmApiConfigSchema.parse(config)).toEqual(config);
  });

  it.each(['', null])('rejects an explicitly invalid internal ID: %s', internal_id => {
    expect(
      CustomLlmApiConfigSchema.safeParse({
        base_url: 'https://llm.example.com/v1',
        internal_id,
      }).success
    ).toBe(false);
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])('resolves disable_url_suffix=%s to %s', (disable_url_suffix, expected) => {
    const provider = buildDirectProvider(
      'custom',
      ['messages'],
      {
        base_url: 'https://llm.example.com/invoke',
        disable_url_suffix,
      },
      API_KEY_AUTH
    );

    expect(provider.disableUrlSuffix).toBe(expected);
  });
});

describe('buildDirectProvider model field', () => {
  it.each<GatewayRequest>([
    {
      kind: 'chat_completions',
      body: { model: 'public-model', messages: [{ role: 'user', content: 'hello' }] },
    },
    {
      kind: 'responses',
      body: { model: 'public-model', input: 'hello' },
    },
    {
      kind: 'messages',
      body: {
        model: 'public-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      },
    },
  ])('removes model from $kind requests when internal_id is absent', async request => {
    await transformRequest(request, {
      internal_id: undefined,
      extra_body: { model: 'extra-body-model', temperature: 0.2 },
    });

    expect(request.body).not.toHaveProperty('model');
    expect(JSON.parse(JSON.stringify(request.body))).not.toHaveProperty('model');
    expect(request.body).toHaveProperty('temperature', 0.2);
  });

  it('keeps the configured internal ID authoritative over body overrides', async () => {
    const request = makeRequest();

    await transformRequest(request, {
      internal_id: 'configured-model',
      remove_from_body: ['model'],
      extra_body: { model: 'extra-body-model' },
    });

    expect(request.body.model).toBe('configured-model');
  });
});

describe('buildDirectProvider Mt-User-Id header', () => {
  const provider = buildDirectProvider(
    'custom',
    ['chat_completions', 'responses', 'messages'],
    { base_url: 'https://llm.example.com/v1' },
    API_KEY_AUTH
  );
  const expectedUserId = 'kilo:' + generateProviderSpecificHash('user-1', provider);

  it.each([true, false])('accepts prompt_cache_key_as_mt_user_id=%s', enabled => {
    const config = {
      base_url: 'https://llm.example.com/v1',
      prompt_cache_key_as_mt_user_id: enabled,
    };

    expect(CustomLlmApiConfigSchema.parse(config)).toEqual(config);
  });

  it.each<GatewayRequest>([
    {
      kind: 'chat_completions',
      body: { model: 'public-model', messages: [], prompt_cache_key: 'task-cache-key' },
    },
    {
      kind: 'responses',
      body: { model: 'public-model', input: 'hello', prompt_cache_key: 'task-cache-key' },
    },
    {
      kind: 'messages',
      body: { model: 'public-model', max_tokens: 100, messages: [] },
    },
  ])('includes the prefixed user hash for $kind when enabled', async request => {
    const headers = await transformRequest(request, { prompt_cache_key_as_mt_user_id: true });

    expect(headers['Mt-User-Id']).toBe(expectedUserId);
    if (request.kind !== 'messages') {
      expect(request.body).toHaveProperty('prompt_cache_key', 'task-cache-key');
    }
  });

  it.each<[string, string | null]>([
    ['user-1', null],
    ['user-1', 'session-1'],
    ['user-1', 'session-2'],
    ['oauth/provider/user-2', 'session-1'],
  ])('uses the tracking user hash for user %s and session %s', async (userId, sessionId) => {
    const request = makeRequest();
    request.body.prompt_cache_key = 'client-cache-key';
    applyTrackingIds(request, provider, userId, sessionId);

    const headers = await transformRequest(
      request,
      { prompt_cache_key_as_mt_user_id: true },
      userId,
      sessionId
    );

    expect(headers['Mt-User-Id']).toBe('kilo:' + generateProviderSpecificHash(userId, provider));
    expect(headers['Mt-User-Id']).toBe('kilo:' + request.body.safety_identifier);
  });

  it.each([undefined, false])('does not add the header when the option is %s', enabled => {
    const request = makeRequest();
    request.body.prompt_cache_key = 'task-cache-key';

    return expect(
      transformRequest(request, { prompt_cache_key_as_mt_user_id: enabled })
    ).resolves.not.toHaveProperty('Mt-User-Id');
  });

  it.each([undefined, null, '', 42, '\u4e2d\u6587', 'key\r\nInjected: value', 'key\0', 'key\x7f'])(
    'uses the user hash regardless of cache key %s',
    async cacheKey => {
      const request = makeRequest();
      Object.assign(request.body, { prompt_cache_key: cacheKey });

      const headers = await transformRequest(request, { prompt_cache_key_as_mt_user_id: true });

      expect(headers['Mt-User-Id']).toBe(expectedUserId);
    }
  );

  it('uses the user hash when the cache key is removed from the upstream body', async () => {
    const request = makeRequest();
    request.body.prompt_cache_key = 'task-cache-key';

    const headers = await transformRequest(request, {
      prompt_cache_key_as_mt_user_id: true,
      remove_from_body: ['prompt_cache_key'],
    });

    expect(headers['Mt-User-Id']).toBe(expectedUserId);
    expect(request.body).not.toHaveProperty('prompt_cache_key');
  });

  it('overrides static header values case-insensitively', async () => {
    const request = makeRequest();
    request.body.prompt_cache_key = 'task-cache-key';

    const headers = await transformRequest(request, {
      prompt_cache_key_as_mt_user_id: true,
      extra_headers: { 'Mt-User-Id': 'static-key', 'mt-user-id': 'other-key', 'x-custom': 'kept' },
    });

    expect(Object.fromEntries(new Headers(headers))).toEqual({
      'mt-user-id': expectedUserId,
      'x-custom': 'kept',
    });
  });
});

describe('custom LLM Gemini reasoning transform configuration', () => {
  const config = {
    internal_id: 'upstream-model',
    base_url: 'https://llm.example.com/v1',
  };

  it('accepts reasoning detail transform enum values', () => {
    expect(
      CustomLlmApiConfigSchema.safeParse({
        ...config,
        reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
      }).success
    ).toBe(true);
    expect(
      CustomLlmApiConfigSchema.safeParse({
        ...config,
        reasoning_details_transform: ReasoningDetailsTransform.ReasoningContent,
      }).success
    ).toBe(true);
  });
});

describe('buildDirectProvider response transforms', () => {
  it('enables Gemini thought content rewriting when the transform is enabled', () => {
    const provider = buildDirectProvider(
      'custom',
      ['chat_completions'],
      {
        internal_id: 'upstream-model',
        base_url: 'https://llm.example.com/v1',
        reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
      },
      API_KEY_AUTH
    );

    expect(provider.responseTransforms).toBe(ReasoningDetailsTransform.GeminiThought);
  });

  it('sets response transforms to null when the transform is not enabled', () => {
    const provider = buildDirectProvider(
      'custom',
      ['chat_completions'],
      {
        internal_id: 'upstream-model',
        base_url: 'https://llm.example.com/v1',
      },
      API_KEY_AUTH
    );

    expect(provider.responseTransforms).toBeNull();
  });
});

describe('buildDirectProvider authentication', () => {
  it('sends API keys straight to base_url', () => {
    const provider = buildDirectProvider(
      'custom',
      ['chat_completions'],
      { base_url: 'https://llm.example.com/v1' },
      { type: 'api_key', apiKey: 'test-key', apiKeyHeader: 'x-api-key' }
    );

    expect(provider).toMatchObject({
      apiUrl: 'https://llm.example.com/v1',
      apiKey: 'test-key',
      apiKeyHeader: 'x-api-key',
    });
    expect(provider.secureProxy).toBeUndefined();
  });

  it('routes secure proxy credentials through base_url to the configured upstream', () => {
    const provider = buildDirectProvider(
      'custom',
      ['messages'],
      { base_url: 'https://secure-proxy.example.com/api/proxy', disable_url_suffix: true },
      {
        type: 'secure_proxy',
        credentials: {
          type: 'secure_proxy',
          proxy_secret: 'proxy-secret',
          config: {
            url: 'https://llm.example.com/invoke',
            extra_headers: { authorization: 'Bearer upstream-key' },
          },
        },
      }
    );

    expect(provider).toMatchObject({
      apiUrl: 'https://llm.example.com/invoke',
      disableUrlSuffix: true,
      apiKey: 'proxy-secret',
      apiKeyHeader: null,
      secureProxy: {
        url: 'https://secure-proxy.example.com/api/proxy',
        upstreamAuthHeaders: { authorization: 'Bearer upstream-key' },
      },
    });
  });
});

describe('buildDirectProvider Gemini reasoning transform', () => {
  it('maps encrypted reasoning details to native tool-call signatures', async () => {
    const request = makeRequest();

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
    });

    expect(request.body.model).toBe('upstream-model');
    expect(request.body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
            extra_content: {
              trace_id: 'trace-1',
              google: { thought_signature: 'assistant-signature' },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: 'result',
        tool_call_id: 'call-1',
      },
    ]);
  });

  it('maps a message-level encrypted detail to a native signature', async () => {
    const request: ChatCompletionRequest = {
      kind: 'chat_completions',
      body: {
        model: 'public-model',
        messages: [{ role: 'assistant', content: 'answer' }],
      },
    };
    Object.assign(request.body.messages[0], {
      reasoning_details: [
        {
          type: 'reasoning.encrypted',
          data: 'root-signature',
          format: 'google-gemini-v1',
        },
      ],
    });

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
    });

    expect(request.body.messages[0]).toEqual({
      role: 'assistant',
      content: 'answer',
      extra_content: { google: { thought_signature: 'root-signature' } },
    });
  });

  it('does not map encrypted details from other reasoning formats', async () => {
    const request = makeRequest();
    const assistant = request.body.messages[0] as unknown as Record<string, unknown>;
    assistant.reasoning_details = [
      {
        type: 'reasoning.encrypted',
        data: 'anthropic-signature',
        format: 'anthropic-claude-v1',
      },
    ];

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
    });

    expect(request.body.messages[0]).not.toHaveProperty('reasoning_details');
    expect(request.body.messages[0]).not.toHaveProperty('extra_content.google.thought_signature');
  });

  it('continues mapping legacy tool-call signatures', async () => {
    const request = makeRequest();
    const assistant = request.body.messages[0] as unknown as Record<string, unknown>;
    delete assistant.reasoning_details;
    Object.assign(assistant.tool_calls as object[], [{ thoughtSignature: 'legacy-signature' }]);

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
    });

    expect(request.body.messages[0]).toHaveProperty(
      'tool_calls.0.extra_content.google.thought_signature',
      'legacy-signature'
    );
    expect(request.body.messages[0]).not.toHaveProperty('tool_calls.0.thoughtSignature');
  });

  it('moves reasoning_effort into google.thinking_config and keeps extra_body', async () => {
    const request = makeRequest();
    request.body.reasoning_effort = 'high';

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
      extra_body: { temperature: 0.2, google: { existing: true } },
      remove_from_body: ['stream'],
    });

    expect(request.body).toMatchObject({
      model: 'upstream-model',
      temperature: 0.2,
      google: {
        existing: true,
        thinking_config: {
          thinking_level: 'high',
          include_thoughts: true,
        },
      },
    });
    expect(request.body).not.toHaveProperty('reasoning_effort');
    expect(request.body).not.toHaveProperty('stream');
  });

  it('does not send an invalid Gemini thinking_level when reasoning_effort is none', async () => {
    const request = makeRequest();
    request.body.reasoning_effort = 'none';

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
      extra_body: { google: { existing: true } },
    });

    const body = request.body as typeof request.body & { google?: Record<string, unknown> };
    expect(body.google).toEqual({ existing: true });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('still sets thinking_config when reasoning_effort is absent', async () => {
    const request = makeRequest();

    await transformRequest(request, {
      reasoning_details_transform: ReasoningDetailsTransform.GeminiThought,
    });

    expect(request.body).toMatchObject({
      google: {
        thinking_config: {
          include_thoughts: true,
        },
      },
    });
    expect(request.body).not.toHaveProperty('reasoning_effort');
  });

  it('preserves reasoning details when the transform is not enabled', async () => {
    const request = makeRequest();

    await transformRequest(request);

    expect(request.body.messages).toMatchObject([
      {
        reasoning_details: [
          {
            type: 'reasoning.encrypted',
            data: 'assistant-signature',
            id: 'call-1',
          },
        ],
      },
      { role: 'tool' },
    ]);
  });
});

describe('buildDirectProvider JSON ref field sanitization', () => {
  it('accepts the sanitization option', () => {
    expect(
      CustomLlmApiConfigSchema.safeParse({
        internal_id: 'upstream-model',
        base_url: 'https://llm.example.com/v1',
        sanitize_ref_fields: true,
      }).success
    ).toBe(true);
  });

  it('recursively renames $ref properties in JSON chat completion tool results', async () => {
    const content = JSON.stringify({
      $ref: '#/$defs/root',
      nested: { $ref: '#/$defs/nested' },
      items: [{ $ref: '#/$defs/item' }],
    });
    const request: ChatCompletionRequest = {
      kind: 'chat_completions',
      body: {
        model: 'public-model',
        messages: [
          { role: 'user', content },
          { role: 'tool', tool_call_id: 'call-1', content },
        ],
      },
    };

    await transformRequest(request, { sanitize_ref_fields: true });

    expect(request.body.messages[0].content).toBe(content);
    expect(JSON.parse(request.body.messages[1].content as string)).toEqual({
      _ref: '#/$defs/root',
      nested: { _ref: '#/$defs/nested' },
      items: [{ _ref: '#/$defs/item' }],
    });
  });

  it.each([
    ['the option is disabled', false, '{ "$ref": "keep" }'],
    ['the tool result is not valid JSON', true, '{ "$ref": "keep"'],
    ['valid JSON has no $ref properties', true, '{ "value": "keep" }'],
  ])('preserves content when %s', async (_description, sanitize_ref_fields, content) => {
    const request: ChatCompletionRequest = {
      kind: 'chat_completions',
      body: {
        model: 'public-model',
        messages: [{ role: 'tool', tool_call_id: 'call-1', content }],
      },
    };

    await transformRequest(request, { sanitize_ref_fields });

    expect(request.body.messages[0].content).toBe(content);
  });

  it('sanitizes JSON in chat completion tool result text parts', async () => {
    const request: ChatCompletionRequest = {
      kind: 'chat_completions',
      body: {
        model: 'public-model',
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call-1',
            content: [{ type: 'text', text: '{"$ref":"rename"}' }],
          },
        ],
      },
    };

    await transformRequest(request, { sanitize_ref_fields: true });

    expect(request.body.messages[0].content).toEqual([{ type: 'text', text: '{"_ref":"rename"}' }]);
  });

  it('does not sanitize Messages API tool results', async () => {
    const content = '{"$ref":"keep"}';
    const request: GatewayRequest = {
      kind: 'messages',
      body: {
        model: 'public-model',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content }],
          },
        ],
      },
    };

    await transformRequest(request, { sanitize_ref_fields: true });

    expect(request.body.messages[0].content[0]).toMatchObject({ content });
  });
});
