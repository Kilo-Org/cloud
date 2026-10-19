import { describe, expect, it } from '@jest/globals';
import { applyProviderSpecificLogic } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  addReflectionReasoningPlaceholders,
  isReflectionModel,
  REASONING_PLACEHOLDER,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reflection';
import { ReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';

type ChatRequest = Extract<GatewayRequest, { kind: 'chat_completions' }>;
type MessagesRequest = Extract<GatewayRequest, { kind: 'messages' }>;
type ResponsesRequest = Extract<GatewayRequest, { kind: 'responses' }>;

const placeholderDetail = { type: 'reasoning.text', text: REASONING_PLACEHOLDER };

function makeChatRequest(assistant: Record<string, unknown>): ChatRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'reflection/beam-free',
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4', ...assistant } as never,
        { role: 'user', content: 'And 3+3?' },
      ],
    },
  };
}

function chatAssistant(request: ChatRequest) {
  return request.body.messages[1] as unknown as Record<string, unknown>;
}

describe('isReflectionModel', () => {
  it.each([
    ['reflection/beam-free', true],
    ['reflection/beam', true],
    ['openai/gpt-5.5', false],
    ['vendor/reflection-model', false],
  ])('%s -> %s', (model, expected) => {
    expect(isReflectionModel(model)).toBe(expected);
  });
});

describe('addReflectionReasoningPlaceholders for chat completions', () => {
  it('adds a placeholder to an assistant message without reasoning', () => {
    const request = makeChatRequest({});

    addReflectionReasoningPlaceholders(request);

    expect(chatAssistant(request).reasoning_details).toEqual([placeholderDetail]);
  });

  it('adds a placeholder to a tool-call message without reasoning', () => {
    const request = makeChatRequest({
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'add', arguments: '{}' } }],
    });

    addReflectionReasoningPlaceholders(request);

    expect(chatAssistant(request).reasoning_details).toEqual([placeholderDetail]);
  });

  it.each([
    { name: 'empty reasoning text', reasoning_details: [{ type: 'reasoning.text', text: '' }] },
    { name: 'empty reasoning_details', reasoning_details: [] },
    { name: 'empty legacy reasoning', reasoning: '' },
    { name: 'empty reasoning_content', reasoning_content: '' },
  ])('treats $name as missing', ({ name: _name, ...assistant }) => {
    const request = makeChatRequest(assistant);

    addReflectionReasoningPlaceholders(request);

    expect(chatAssistant(request).reasoning_details).toContainEqual(placeholderDetail);
  });

  it('keeps encrypted details from another model and appends the placeholder', () => {
    const encrypted = {
      type: 'reasoning.encrypted',
      data: 'opaque',
      format: 'anthropic-claude-v1',
    };
    const request = makeChatRequest({ reasoning_details: [encrypted] });

    addReflectionReasoningPlaceholders(request);

    expect(chatAssistant(request).reasoning_details).toEqual([encrypted, placeholderDetail]);
  });

  it.each([
    { reasoning_details: [{ type: 'reasoning.text', text: 'thought' }] },
    { reasoning_details: [{ type: 'reasoning.summary', summary: 'thought' }] },
    { reasoning: 'thought' },
    { reasoning_content: 'thought' },
  ])('leaves an assistant message with reasoning unchanged: %j', assistant => {
    const request = makeChatRequest(assistant);

    addReflectionReasoningPlaceholders(request);

    expect(chatAssistant(request)).toEqual({ role: 'assistant', content: '4', ...assistant });
  });

  it('does not touch user messages', () => {
    const request = makeChatRequest({});

    addReflectionReasoningPlaceholders(request);

    expect(request.body.messages[0]).toEqual({ role: 'user', content: 'What is 2+2?' });
  });
});

describe('addReflectionReasoningPlaceholders for messages', () => {
  function makeMessagesRequest(
    content: MessagesRequest['body']['messages'][number]['content']
  ): MessagesRequest {
    return {
      kind: 'messages',
      body: {
        model: 'reflection/beam-free',
        max_tokens: 1_024,
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content },
          { role: 'user', content: 'And 3+3?' },
        ],
      },
    };
  }

  const placeholderBlock = { type: 'thinking', thinking: REASONING_PLACEHOLDER, signature: '' };

  it('converts string content to a placeholder thinking block and text', () => {
    const request = makeMessagesRequest('4');

    addReflectionReasoningPlaceholders(request);

    expect(request.body.messages[1].content).toEqual([
      placeholderBlock,
      { type: 'text', text: '4' },
    ]);
  });

  it('prepends a placeholder when there is no thinking block', () => {
    const request = makeMessagesRequest([
      { type: 'tool_use', id: 'call-1', name: 'add', input: {} },
    ]);

    addReflectionReasoningPlaceholders(request);

    expect(request.body.messages[1].content).toEqual([
      placeholderBlock,
      { type: 'tool_use', id: 'call-1', name: 'add', input: {} },
    ]);
  });

  it('keeps a thinking block that has text', () => {
    const content = [
      { type: 'thinking' as const, thinking: 'thought', signature: '' },
      { type: 'text' as const, text: '4' },
    ];
    const request = makeMessagesRequest(structuredClone(content));

    addReflectionReasoningPlaceholders(request);

    expect(request.body.messages[1].content).toEqual(content);
  });
});

describe('addReflectionReasoningPlaceholders for responses', () => {
  const reasoning = {
    type: 'reasoning' as const,
    id: 'rs_1',
    summary: [{ type: 'summary_text' as const, text: 'thought' }],
  };
  const functionCall = {
    type: 'function_call' as const,
    call_id: 'call-1',
    name: 'add',
    arguments: '{}',
  };
  const functionCallOutput = {
    type: 'function_call_output' as const,
    call_id: 'call-1',
    output: '4',
  };
  const assistantMessage = { role: 'assistant' as const, content: '2+2 is 4.' };
  const user = { role: 'user' as const, content: 'Add 2+2.' };

  function makeResponsesRequest(input: ResponsesRequest['body']['input']): ResponsesRequest {
    return { kind: 'responses', body: { model: 'reflection/beam-free', input } };
  }

  function placeholderItem(index: number) {
    return {
      type: 'reasoning',
      id: `rs_reasoning_unavailable_${index}`,
      summary: [{ type: 'summary_text', text: REASONING_PLACEHOLDER }],
    };
  }

  it('adds a placeholder before each assistant turn without reasoning', () => {
    const request = makeResponsesRequest([
      user,
      functionCall,
      functionCallOutput,
      assistantMessage,
      user,
    ]);

    addReflectionReasoningPlaceholders(request);

    expect(request.body.input).toEqual([
      user,
      placeholderItem(0),
      functionCall,
      functionCallOutput,
      placeholderItem(1),
      assistantMessage,
      user,
    ]);
  });

  it('treats consecutive assistant items as one turn', () => {
    const request = makeResponsesRequest([
      user,
      reasoning,
      assistantMessage,
      functionCall,
      functionCallOutput,
    ]);

    addReflectionReasoningPlaceholders(request);

    expect(request.body.input).toEqual([
      user,
      reasoning,
      assistantMessage,
      functionCall,
      functionCallOutput,
    ]);
  });

  it('adds a placeholder when the reasoning item has no text', () => {
    const emptyReasoning = { type: 'reasoning' as const, id: 'rs_1', summary: [] };
    const request = makeResponsesRequest([user, emptyReasoning, assistantMessage]);

    addReflectionReasoningPlaceholders(request);

    expect(request.body.input).toEqual([
      user,
      placeholderItem(0),
      emptyReasoning,
      assistantMessage,
    ]);
  });

  it('leaves string input unchanged', () => {
    const request = makeResponsesRequest('hello');

    addReflectionReasoningPlaceholders(request);

    expect(request.body.input).toBe('hello');
  });
});

describe('applyProviderSpecificLogic reasoning placeholders', () => {
  async function apply(model: string, responseTransforms: ReasoningDetailsTransform | null) {
    const request = makeChatRequest({});
    request.body.model = model;
    await applyProviderSpecificLogic(
      {
        id: 'openrouter',
        apiUrl: 'https://example.com/v1',
        apiUrlOverrides: {},
        disableUrlSuffix: false,
        apiKey: 'test-key',
        apiKeyHeader: null,
        supportedChatApis: ['chat_completions'],
        responseTransforms,
        async transformRequest() {},
      },
      model,
      request,
      {},
      null,
      EmptyFraudDetectionHeaders,
      'user-1',
      null,
      null,
      null,
      false
    );
    return chatAssistant(request);
  }

  it('adds placeholders for Reflection models', async () => {
    expect((await apply('reflection/beam-free', null)).reasoning_details).toEqual([
      placeholderDetail,
    ]);
  });

  it('folds the placeholder into reasoning_content for reasoning-content upstreams', async () => {
    expect(
      (await apply('reflection/beam', ReasoningDetailsTransform.ReasoningContent)).reasoning_content
    ).toBe(REASONING_PLACEHOLDER);
  });

  it('does not add placeholders for other models', async () => {
    expect(await apply('vendor/model', null)).not.toHaveProperty('reasoning_details');
  });
});
