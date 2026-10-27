import { describe, expect, it } from '@jest/globals';
import { enkryptGuardrailRejectionResponse } from './responses';

const block = { action: 'block', message: 'Blocked: prompt injection.' } as const;

describe('enkryptGuardrailRejectionResponse', () => {
  it('sends an allowed request upstream', () => {
    expect(enkryptGuardrailRejectionResponse('chat_completions', { action: 'allow' })).toBeNull();
  });

  it.each(['chat_completions', 'responses'] as const)(
    'returns an OpenAI error for a block on %s',
    async kind => {
      const response = enkryptGuardrailRejectionResponse(kind, block);

      expect(response?.status).toBe(400);
      expect(response?.headers.get('x-should-retry')).toBe('false');
      expect(await response?.json()).toEqual({
        error: {
          message: 'Blocked: prompt injection.',
          type: 'invalid_request_error',
          code: 'guardrail_blocked',
          param: null,
        },
        error_type: 'guardrail_blocked',
      });
    }
  );

  it('returns an Anthropic error for a block on messages', async () => {
    const response = enkryptGuardrailRejectionResponse('messages', block);

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Blocked: prompt injection.' },
      error_type: 'guardrail_blocked',
    });
  });

  it.each([
    [
      'chat_completions',
      {
        error: {
          message: expect.stringContaining('could not check this request'),
          type: 'server_error',
          code: 'guardrail_unavailable',
          param: null,
        },
        error_type: 'guardrail_unavailable',
      },
    ],
    [
      'messages',
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: expect.stringContaining('could not check this request'),
        },
        error_type: 'guardrail_unavailable',
      },
    ],
  ] as const)('returns a retryable error when failing closed on %s', async (kind, body) => {
    const response = enkryptGuardrailRejectionResponse(kind, { action: 'unavailable' });

    expect(response?.status).toBe(503);
    expect(response?.headers.get('retry-after')).toBe('1');
    expect(await response?.json()).toEqual(body);
  });
});
