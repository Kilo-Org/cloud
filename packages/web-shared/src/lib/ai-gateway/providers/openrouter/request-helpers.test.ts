import type { GatewayRequest } from './types';
import { enableReasoningSummaries } from './request-helpers';

function responsesRequest(
  body: Partial<Extract<GatewayRequest, { kind: 'responses' }>['body']>
): Extract<GatewayRequest, { kind: 'responses' }> {
  return { kind: 'responses', body: { model: 'meta/muse-spark-1.3', input: 'hello', ...body } };
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
