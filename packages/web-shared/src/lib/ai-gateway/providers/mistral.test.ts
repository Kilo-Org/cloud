import { describe, expect, it } from '@jest/globals';
import { ReasoningDetailsTransform } from '@kilocode/db/schema-types';
import { applyReasoningDetailsTransform } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import {
  applyMistralThinkingRequestTransform,
  mapMistralThinkingToReasoningDetails,
} from '@kilocode/web-shared/lib/ai-gateway/providers/mistral';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { applyReasoningDetailsResponseTransform } from '@kilocode/web-shared/lib/ai-gateway/reasoning-details-transform';

type ChatCompletionsRequest = Extract<GatewayRequest, { kind: 'chat_completions' }>;

function chatRequest(
  messages: unknown[] = [{ role: 'user', content: 'hello' }],
  extra: Record<string, unknown> = {}
): ChatCompletionsRequest {
  return {
    kind: 'chat_completions',
    body: { model: 'mistralai/mistral-medium-3.5', messages, ...extra } as never,
  };
}

function messagesOf(request: ChatCompletionsRequest) {
  return request.body.messages as unknown as Record<string, unknown>[];
}

function thinkingChunk(text: string) {
  return { type: 'thinking', thinking: [{ type: 'text', text }] };
}

describe('applyMistralThinkingRequestTransform', () => {
  it('defaults the reasoning effort to high', () => {
    const request = chatRequest();

    applyMistralThinkingRequestTransform(request);

    expect(request.body.reasoning_effort).toBe('high');
  });

  it('maps the reasoning object effort to reasoning_effort and removes the object', () => {
    const request = chatRequest(undefined, { reasoning: { effort: 'low' } });

    applyMistralThinkingRequestTransform(request);

    expect(request.body.reasoning_effort).toBe('low');
    expect(request.body).not.toHaveProperty('reasoning');
  });

  it('keeps an existing reasoning_effort', () => {
    const request = chatRequest(undefined, { reasoning_effort: 'medium' });

    applyMistralThinkingRequestTransform(request);

    expect(request.body.reasoning_effort).toBe('medium');
  });

  it('prefers the reasoning object effort over reasoning_effort', () => {
    const request = chatRequest(undefined, {
      reasoning: { effort: 'low' },
      reasoning_effort: 'high',
    });

    applyMistralThinkingRequestTransform(request);

    expect(request.body.reasoning_effort).toBe('low');
  });

  it.each([
    ['a reasoning effort of none', { reasoning: { effort: 'none' } }],
    ['reasoning_effort none', { reasoning_effort: 'none' }],
    ['enable_thinking false', { enable_thinking: false }],
    ['a disabled thinking toggle', { thinking: { type: 'disabled' } }],
    ['a disabled reasoning object', { reasoning: { enabled: false } }],
  ])('sends none for %s', (_name, extra) => {
    const request = chatRequest(undefined, extra);

    applyMistralThinkingRequestTransform(request);

    expect(request.body.reasoning_effort).toBe('none');
  });

  it('replays reasoning_details before string content as a leading thinking chunk', () => {
    const request = chatRequest([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'answer',
        reasoning_details: [
          { type: 'reasoning.text', text: 'first ' },
          { type: 'reasoning.summary', summary: 'not transplanted' },
          { type: 'reasoning.encrypted', data: 'opaque' },
          { type: 'reasoning.text', text: 'second' },
        ],
      },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)[1]).toEqual({
      role: 'assistant',
      content: [thinkingChunk('first second'), { type: 'text', text: 'answer' }],
    });
  });

  it('replays reasoning_content before array content', () => {
    const request = chatRequest([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        reasoning_content: 'pondering',
      },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)[0]).toEqual({
      role: 'assistant',
      content: [thinkingChunk('pondering'), { type: 'text', text: 'answer' }],
    });
  });

  it('replays a reasoning string and sends only the thinking chunk when there is no content', () => {
    const request = chatRequest([
      { role: 'assistant', content: null, reasoning: 'only thoughts', tool_calls: [] },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)[0]).toEqual({
      role: 'assistant',
      content: [thinkingChunk('only thoughts')],
      tool_calls: [],
    });
  });

  it('prefers reasoning_details over reasoning_content', () => {
    const request = chatRequest([
      {
        role: 'assistant',
        content: 'answer',
        reasoning_details: [{ type: 'reasoning.text', text: 'from details' }],
        reasoning_content: 'from content',
      },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)[0]?.content).toEqual([
      thinkingChunk('from details'),
      { type: 'text', text: 'answer' },
    ]);
  });

  it.each([
    ['empty reasoning_details', []],
    ['summary-only reasoning_details', [{ type: 'reasoning.summary', summary: 'a summary' }]],
  ])('falls back to reasoning_content for %s', (_name, reasoningDetails) => {
    const request = chatRequest([
      {
        role: 'assistant',
        content: 'answer',
        reasoning_details: reasoningDetails,
        reasoning_content: 'from content',
      },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)[0]?.content).toEqual([
      thinkingChunk('from content'),
      { type: 'text', text: 'answer' },
    ]);
  });

  it('skips an empty reasoning_content and replays the reasoning string', () => {
    const request = chatRequest([
      { role: 'assistant', content: 'answer', reasoning_content: '', reasoning: 'from reasoning' },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)[0]?.content).toEqual([
      thinkingChunk('from reasoning'),
      { type: 'text', text: 'answer' },
    ]);
  });

  it('leaves assistant and non-assistant messages without reasoning untouched', () => {
    const request = chatRequest([
      { role: 'user', content: 'hello', reasoning_content: 'ignored on user messages' },
      { role: 'assistant', content: 'plain answer' },
    ]);

    applyMistralThinkingRequestTransform(request);

    expect(messagesOf(request)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'plain answer' },
    ]);
  });

  it('removes reasoning fields from every message and leaves other fields alone', () => {
    const request = chatRequest(
      [
        { role: 'user', content: 'question', reasoning_content: 'stray' },
        {
          role: 'assistant',
          content: 'answer',
          reasoning_details: [{ type: 'reasoning.text', text: 'thoughts' }],
          reasoning_content: 'thoughts',
          reasoning: 'thoughts',
        },
      ],
      {
        reasoning: { effort: 'low' },
        usage: { include: true },
        prompt_cache_key: 'cache-key',
        temperature: 0.3,
        max_completion_tokens: 100,
      }
    );

    applyMistralThinkingRequestTransform(request);

    // `usage` and other fields Mistral rejects are the definition's `remove_from_body` to drop.
    expect(request.body).toEqual({
      model: 'mistralai/mistral-medium-3.5',
      messages: [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: [thinkingChunk('thoughts'), { type: 'text', text: 'answer' }],
        },
      ],
      reasoning_effort: 'low',
      usage: { include: true },
      prompt_cache_key: 'cache-key',
      temperature: 0.3,
      max_completion_tokens: 100,
    });
  });

  it('does nothing for other API kinds', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: { model: 'mistralai/mistral-medium-3.5', input: 'hello', user: 'user-id' },
    };

    applyMistralThinkingRequestTransform(request);

    expect(request.body).toEqual({
      model: 'mistralai/mistral-medium-3.5',
      input: 'hello',
      user: 'user-id',
    });
  });

  it('is applied by applyReasoningDetailsTransform for the mistral-thinking transform', () => {
    const provider: Provider = {
      type: 'partner',
      apiUrl: 'https://example.com/v1',
      apiUrlOverrides: {},
      disableUrlSuffix: false,
      apiKey: 'test-key',
      apiKeyHeader: null,
      supportedChatApis: ['chat_completions'],
      responseTransforms: ReasoningDetailsTransform.MistralThinking,
      async transformRequest() {},
    };
    const request = chatRequest(undefined, { reasoning: { effort: 'low' } });

    applyReasoningDetailsTransform(provider, request);

    expect(request.body.reasoning_effort).toBe('low');
    expect(request.body).not.toHaveProperty('reasoning');
  });
});

describe('mapMistralThinkingToReasoningDetails', () => {
  const reasoningDetail = (text: string) => ({
    type: 'reasoning.text',
    text,
    index: 0,
    format: 'unknown',
  });

  it('moves thinking out of a non-streaming message content list', () => {
    const message: Record<string, unknown> = {
      role: 'assistant',
      content: [
        thinkingChunk('step one '),
        thinkingChunk('step two'),
        { type: 'text', text: 'Hi' },
      ],
    };

    mapMistralThinkingToReasoningDetails(message);

    expect(message).toEqual({
      role: 'assistant',
      content: 'Hi',
      reasoning_details: [reasoningDetail('step one step two')],
    });
  });

  it('turns a thinking-only streaming delta into reasoning_details with null content', () => {
    const delta: Record<string, unknown> = { content: [thinkingChunk('hmm')] };

    mapMistralThinkingToReasoningDetails(delta);

    expect(delta).toEqual({ content: null, reasoning_details: [reasoningDetail('hmm')] });
  });

  it('splits a transition delta into reasoning_details and content text', () => {
    const delta: Record<string, unknown> = {
      content: [thinkingChunk('done thinking'), { type: 'text', text: 'Answer' }],
    };

    mapMistralThinkingToReasoningDetails(delta);

    expect(delta).toEqual({
      content: 'Answer',
      reasoning_details: [reasoningDetail('done thinking')],
    });
  });

  it('leaves a text-only content list as a string without reasoning_details', () => {
    const delta: Record<string, unknown> = { content: [{ type: 'text', text: 'Answer' }] };

    mapMistralThinkingToReasoningDetails(delta);

    expect(delta).toEqual({ content: 'Answer' });
  });

  it.each([
    ['string content', { content: 'plain answer' }],
    ['missing content', { role: 'assistant' }],
    ['null content', { content: null }],
  ])('leaves %s untouched', (_name, message) => {
    const copy = structuredClone(message);

    mapMistralThinkingToReasoningDetails(message);

    expect(message).toEqual(copy);
  });

  it('ignores values that are not records', () => {
    expect(() => mapMistralThinkingToReasoningDetails(null)).not.toThrow();
    expect(() => mapMistralThinkingToReasoningDetails('text')).not.toThrow();
  });

  it('is applied by applyReasoningDetailsResponseTransform for the mistral-thinking transform', () => {
    const message: Record<string, unknown> = {
      content: [thinkingChunk('thoughts'), { type: 'text', text: 'Answer' }],
    };

    applyReasoningDetailsResponseTransform(ReasoningDetailsTransform.MistralThinking, message);

    expect(message).toEqual({
      content: 'Answer',
      reasoning_details: [reasoningDetail('thoughts')],
    });
  });
});
