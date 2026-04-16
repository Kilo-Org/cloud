import {
  applyAnthropicModelSettings,
  appendPlaceholderUserMessageIfLastIsAssistant,
} from '@/lib/ai-gateway/providers/anthropic';
import type {
  GatewayMessagesRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';

function createChatCompletionsRequest(
  overrides: Partial<OpenRouterChatCompletionRequest> = {}
): OpenRouterChatCompletionRequest {
  return {
    model: 'anthropic/claude-sonnet-4',
    messages: [],
    ...overrides,
  };
}

describe('appendPlaceholderUserMessageIfLastIsAssistant', () => {
  it('appends a placeholder user message when the last message is an assistant message', () => {
    const request = createChatCompletionsRequest({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there' },
      ],
    });

    appendPlaceholderUserMessageIfLastIsAssistant(request);

    expect(request.messages).toHaveLength(3);
    expect(request.messages[2]).toEqual({ role: 'user', content: 'Continue.' });
  });

  it('does not modify requests whose last message is a user message', () => {
    const request = createChatCompletionsRequest({
      messages: [
        { role: 'assistant', content: 'Hello there' },
        { role: 'user', content: 'Hi' },
      ],
    });

    appendPlaceholderUserMessageIfLastIsAssistant(request);

    expect(request.messages).toHaveLength(2);
    expect(request.messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });

  it('does not modify requests whose last message is a tool message', () => {
    const request = createChatCompletionsRequest({
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Result' },
      ],
    });

    appendPlaceholderUserMessageIfLastIsAssistant(request);

    expect(request.messages).toHaveLength(3);
  });

  it('leaves an empty message list unchanged', () => {
    const request = createChatCompletionsRequest({ messages: [] });

    appendPlaceholderUserMessageIfLastIsAssistant(request);

    expect(request.messages).toHaveLength(0);
  });
});

describe('applyAnthropicModelSettings', () => {
  it('appends a placeholder user message for chat_completions when the last message is from the assistant', () => {
    const body = createChatCompletionsRequest({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there' },
      ],
    });

    applyAnthropicModelSettings({ kind: 'chat_completions', body }, {});

    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Continue.' });
  });

  it('does not add a placeholder for the messages (native Anthropic) API kind', () => {
    const body: GatewayMessagesRequest = {
      model: 'anthropic/claude-sonnet-4',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello there' },
      ],
    };

    applyAnthropicModelSettings({ kind: 'messages', body }, {});

    expect(body.messages).toHaveLength(2);
    expect(body.messages.at(-1)).toEqual({ role: 'assistant', content: 'Hello there' });
  });

  it('does not add a placeholder for the responses API kind', () => {
    const body: GatewayResponsesRequest = {
      model: 'anthropic/claude-sonnet-4',
      input: [
        { type: 'message', role: 'user', content: 'Hi' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello there', annotations: [] }],
          id: 'msg_1',
          status: 'completed',
        },
      ],
    };

    applyAnthropicModelSettings({ kind: 'responses', body }, {});

    if (!Array.isArray(body.input)) {
      throw new Error('expected input to be an array');
    }
    expect(body.input).toHaveLength(2);
  });
});
