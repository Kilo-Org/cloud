import { describe, expect, it } from '@jest/globals';
import { CustomLlmApiConfigSchema } from '@kilocode/db';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { ReasoningDetailsTransform } from '@/lib/ai-gateway/providers/types';
import { buildDirectProvider } from './build-direct-provider';

type ChatCompletionRequest = Extract<GatewayRequest, { kind: 'chat_completions' }>;

async function transformRequest(
  request: GatewayRequest,
  options: {
    sanitize_ref_fields?: boolean;
    use_gemini_reasoning_transform?: boolean;
    extra_body?: Record<string, unknown>;
    remove_from_body?: string[];
  } = {}
) {
  const provider = buildDirectProvider('custom', ['chat_completions'], {
    internal_id: 'upstream-model',
    base_url: 'https://llm.example.com/v1',
    api_key: 'test-key',
    ...options,
  });

  await provider.transformRequest({
    provider,
    model: 'public-model',
    request,
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders: {},
    userByok: null,
    kilo_user_id: 'user-1',
    organization_id: null,
    session_id: null,
  });
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

describe('custom LLM Gemini reasoning transform configuration', () => {
  const config = {
    internal_id: 'upstream-model',
    base_url: 'https://llm.example.com/v1',
  };

  it('accepts the Gemini reasoning transform flag', () => {
    expect(
      CustomLlmApiConfigSchema.safeParse({
        ...config,
        use_gemini_reasoning_transform: true,
      }).success
    ).toBe(true);
  });
});

describe('buildDirectProvider response transforms', () => {
  it('enables Gemini thought content rewriting when the transform is enabled', () => {
    const provider = buildDirectProvider('custom', ['chat_completions'], {
      internal_id: 'upstream-model',
      base_url: 'https://llm.example.com/v1',
      api_key: 'test-key',
      use_gemini_reasoning_transform: true,
    });

    expect(provider.responseTransforms).toBe(ReasoningDetailsTransform.GeminiThought);
  });

  it('sets response transforms to null when the transform is not enabled', () => {
    const provider = buildDirectProvider('custom', ['chat_completions'], {
      internal_id: 'upstream-model',
      base_url: 'https://llm.example.com/v1',
      api_key: 'test-key',
    });

    expect(provider.responseTransforms).toBeNull();
  });
});

describe('buildDirectProvider Gemini reasoning transform', () => {
  it('maps encrypted reasoning details to native tool-call signatures', async () => {
    const request = makeRequest();

    await transformRequest(request, {
      use_gemini_reasoning_transform: true,
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

    await transformRequest(request, { use_gemini_reasoning_transform: true });

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

    await transformRequest(request, { use_gemini_reasoning_transform: true });

    expect(request.body.messages[0]).not.toHaveProperty('reasoning_details');
    expect(request.body.messages[0]).not.toHaveProperty('extra_content.google.thought_signature');
  });

  it('continues mapping legacy tool-call signatures', async () => {
    const request = makeRequest();
    const assistant = request.body.messages[0] as unknown as Record<string, unknown>;
    delete assistant.reasoning_details;
    Object.assign(assistant.tool_calls as object[], [{ thoughtSignature: 'legacy-signature' }]);

    await transformRequest(request, { use_gemini_reasoning_transform: true });

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
      use_gemini_reasoning_transform: true,
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
      use_gemini_reasoning_transform: true,
      extra_body: { google: { existing: true } },
    });

    const body = request.body as typeof request.body & { google?: Record<string, unknown> };
    expect(body.google).toEqual({ existing: true });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('still sets thinking_config when reasoning_effort is absent', async () => {
    const request = makeRequest();

    await transformRequest(request, { use_gemini_reasoning_transform: true });

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
