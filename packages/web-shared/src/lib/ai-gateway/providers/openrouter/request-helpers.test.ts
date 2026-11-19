import type { GatewayRequest } from './types';
import {
  applyThinkingToggleAndReasoningEffort,
  enableReasoningSummaries,
  isReasoningExplicitlyDisabled,
} from './request-helpers';

function responsesRequest(
  body: Partial<Extract<GatewayRequest, { kind: 'responses' }>['body']>
): Extract<GatewayRequest, { kind: 'responses' }> {
  return { kind: 'responses', body: { model: 'meta/muse-spark-1.3', input: 'hello', ...body } };
}

function chatRequest(
  body: Partial<Extract<GatewayRequest, { kind: 'chat_completions' }>['body']>
): Extract<GatewayRequest, { kind: 'chat_completions' }> {
  return { kind: 'chat_completions', body: { model: 'zai/glm-5', messages: [], ...body } };
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

describe('applyThinkingToggleAndReasoningEffort', () => {
  test('enables thinking and keeps the reasoning effort for Chat Completions requests', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'zai/glm-5', messages: [], reasoning: { effort: 'high' } },
    };

    applyThinkingToggleAndReasoningEffort(request);

    expect(request.body).toEqual({
      model: 'zai/glm-5',
      messages: [],
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
    expect(request.body).not.toHaveProperty('reasoning');
  });

  test('disables thinking when the client disables it', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'zai/glm-5', messages: [], enable_thinking: false },
    };

    applyThinkingToggleAndReasoningEffort(request);

    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });

  test('disables thinking for an explicit reasoning disable', () => {
    const request = chatRequest({ reasoning: { enabled: false } });

    applyThinkingToggleAndReasoningEffort(request);

    expect(request.body).toEqual({
      model: 'zai/glm-5',
      messages: [],
      thinking: { type: 'disabled' },
    });
  });

  test('disables thinking for a none reasoning effort', () => {
    const request = chatRequest({ reasoning: { effort: 'none' } });

    applyThinkingToggleAndReasoningEffort(request);

    expect(request.body.thinking).toEqual({ type: 'disabled' });
    expect(request.body.reasoning_effort).toBe('none');
  });

  test('leaves Responses and Messages requests untouched', () => {
    const requests: GatewayRequest[] = [
      responsesRequest({ reasoning: { effort: 'high' } }),
      {
        kind: 'messages',
        body: { model: 'anthropic/claude-sonnet-5.5', max_tokens: 1024, messages: [] },
      },
    ];
    const before = structuredClone(requests);

    for (const request of requests) {
      applyThinkingToggleAndReasoningEffort(request);
    }

    expect(requests).toEqual(before);
  });
});

describe('isReasoningExplicitlyDisabled', () => {
  const cases: [Partial<Extract<GatewayRequest, { kind: 'chat_completions' }>['body']>, boolean][] =
    [
      [{ reasoning: { enabled: false } }, true],
      [{ reasoning: { enabled: false, effort: 'high' } }, true],
      [{ reasoning: { effort: 'none' } }, true],
      [{ reasoning_effort: 'none' }, true],
      [{ enable_thinking: false }, true],
      [{ thinking: { type: 'disabled' } }, true],
      [{ reasoning: { enabled: true, effort: 'none' } }, false],
      [{ reasoning: { effort: 'high' } }, false],
    ];

  test.each(cases)('%j is %s', (body, expected) => {
    expect(isReasoningExplicitlyDisabled(chatRequest(body))).toBe(expected);
  });
});
