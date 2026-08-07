import { describe, expect, it } from '@jest/globals';
import { CustomLlmApiConfigSchema } from '@kilocode/db';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { buildDirectProvider } from './build-direct-provider';

type ChatCompletionRequest = Extract<GatewayRequest, { kind: 'chat_completions' }>;

async function transformRequest(
  request: GatewayRequest,
  options: { sanitize_ref_fields?: boolean; thought_signature_mapping?: string } = {}
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
  const request: ChatCompletionRequest = {
    kind: 'chat_completions',
    body: {
      model: 'public-model',
      stream: false,
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall],
        },
        toolMessage,
      ],
    },
  };

  Object.assign(toolCall, {
    thoughtSignature: 'assistant-signature',
    extra_content: { trace_id: 'trace-1' },
  });
  Object.assign(toolMessage, { thoughtSignature: 'tool-signature' });

  return request;
}

describe('custom LLM thought signature mapping configuration', () => {
  const config = {
    internal_id: 'upstream-model',
    base_url: 'https://llm.example.com/v1',
  };

  it('accepts a dot-separated property path', () => {
    expect(
      CustomLlmApiConfigSchema.safeParse({
        ...config,
        thought_signature_mapping: 'extra_content.provider.thought_signature',
      }).success
    ).toBe(true);
  });

  it.each(['', 'extra_content..thought_signature', '__proto__.thought_signature'])(
    'rejects unsafe property path %p',
    thought_signature_mapping => {
      expect(
        CustomLlmApiConfigSchema.safeParse({ ...config, thought_signature_mapping }).success
      ).toBe(false);
    }
  );
});

describe('buildDirectProvider thought signature mapping', () => {
  it('maps assistant tool-call signatures and removes camel-case transport fields', async () => {
    const request = makeRequest();

    await transformRequest(request, {
      thought_signature_mapping: 'extra_content.provider.thought_signature',
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
              provider: { thought_signature: 'assistant-signature' },
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

  it('preserves signatures when no mapping is configured', async () => {
    const request = makeRequest();

    await transformRequest(request);

    expect(request.body.messages).toMatchObject([
      {
        tool_calls: [{ thoughtSignature: 'assistant-signature' }],
      },
      { thoughtSignature: 'tool-signature' },
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
