import type { GatewayRequest } from './types';
import { addCacheBreakpoints, enableReasoningSummaries } from './request-helpers';

function responsesRequest(
  body: Partial<Extract<GatewayRequest, { kind: 'responses' }>['body']>
): Extract<GatewayRequest, { kind: 'responses' }> {
  return { kind: 'responses', body: { model: 'meta/muse-spark-1.3', input: 'hello', ...body } };
}

function messagesRequest(
  content: Extract<GatewayRequest, { kind: 'messages' }>['body']['messages'][number]['content']
): Extract<GatewayRequest, { kind: 'messages' }> {
  return {
    kind: 'messages',
    body: {
      model: 'anthropic/claude-sonnet-5.5',
      max_tokens: 1024,
      messages: [{ role: 'user', content }],
    },
  };
}

function lastMessageContent(request: Extract<GatewayRequest, { kind: 'messages' }>) {
  const lastMessage = request.body.messages.at(-1);
  return Array.isArray(lastMessage?.content) ? lastMessage.content : [];
}

describe('enableReasoningSummaries', () => {
  test('requests summaries for Responses requests without a reasoning object', () => {
    const request = responsesRequest({});

    enableReasoningSummaries(request);

    expect(request.body.reasoning).toEqual({ summary: 'auto' });
  });

  test('requests summaries when the reasoning object is null', () => {
    const request = responsesRequest({ reasoning: null });

    enableReasoningSummaries(request);

    expect(request.body.reasoning).toEqual({ summary: 'auto' });
  });

  test('keeps the requested effort when adding summaries', () => {
    const request = responsesRequest({ reasoning: { effort: 'low' } });

    enableReasoningSummaries(request);

    expect(request.body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });

  test('keeps an explicitly requested summary mode', () => {
    const request = responsesRequest({ reasoning: { effort: 'high', summary: 'detailed' } });

    enableReasoningSummaries(request);

    expect(request.body.reasoning).toEqual({ effort: 'high', summary: 'detailed' });
  });

  test('leaves Chat Completions requests without reasoning untouched', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'meta/muse-spark-1.3', messages: [] },
    };

    enableReasoningSummaries(request);

    expect(request.body).not.toHaveProperty('reasoning');
  });

  test('leaves Messages requests without thinking untouched', () => {
    const request: GatewayRequest = {
      kind: 'messages',
      body: { model: 'anthropic/claude-sonnet-5.5', max_tokens: 1024, messages: [] },
    };

    enableReasoningSummaries(request);

    expect(request.body).not.toHaveProperty('thinking');
  });
});

describe('addCacheBreakpoints', () => {
  test('breaks before environment details, never on a trailing reasoning block', () => {
    // The block before <environment_details> is a thinking block, and the content also ends on a
    // thinking block. So the fallback must skip reasoning twice: a plain "last block" fallback
    // would land on the trailing reasoning block instead of the environment-details text.
    const request = messagesRequest([
      { type: 'text', text: 'prompt' },
      { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
      { type: 'text', text: '<environment_details>x</environment_details>' },
      { type: 'thinking', thinking: 'more reasoning', signature: 'sig2' },
    ]);

    addCacheBreakpoints(request);

    const blocks = lastMessageContent(request);
    expect(blocks[2]).toHaveProperty('cache_control');
    expect(blocks[0]).not.toHaveProperty('cache_control');
    expect(blocks[1]).not.toHaveProperty('cache_control');
    expect(blocks[3]).not.toHaveProperty('cache_control');
  });

  test('breaks on the block before environment details when it is cacheable', () => {
    const request = messagesRequest([
      { type: 'text', text: 'hello' },
      { type: 'text', text: '<environment_details>x</environment_details>' },
      { type: 'text', text: 'after' },
    ]);

    addCacheBreakpoints(request);

    const blocks = lastMessageContent(request);
    expect(blocks[0]).toHaveProperty('cache_control');
    expect(blocks[1]).not.toHaveProperty('cache_control');
    expect(blocks[2]).not.toHaveProperty('cache_control');
  });

  test('skips a thinking block that sits before environment details', () => {
    const request = messagesRequest([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
      { type: 'text', text: '<environment_details>x</environment_details>' },
    ]);

    addCacheBreakpoints(request);

    const blocks = lastMessageContent(request);
    expect(blocks[2]).toHaveProperty('cache_control');
    expect(blocks[0]).not.toHaveProperty('cache_control');
    expect(blocks[1]).not.toHaveProperty('cache_control');
  });

  test('skips a redacted_thinking block that sits before environment details', () => {
    const request = messagesRequest([
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: '<environment_details>x</environment_details>' },
      { type: 'text', text: 'after' },
    ]);

    addCacheBreakpoints(request);

    const blocks = lastMessageContent(request);
    expect(blocks[2]).toHaveProperty('cache_control');
    expect(blocks[0]).not.toHaveProperty('cache_control');
  });
});
