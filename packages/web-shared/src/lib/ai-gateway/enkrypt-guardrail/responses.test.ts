import { describe, expect, it } from '@jest/globals';
import {
  enkryptGuardrailRejectionResponse,
  enkryptOutputGuardrailRejectionResponse,
} from './responses';

const block = { action: 'block', message: 'Blocked: prompt injection.' } as const;

describe('enkryptGuardrailRejectionResponse', () => {
  it.each(['skip', 'allow'] as const)('sends the request upstream on %s', action => {
    expect(enkryptGuardrailRejectionResponse('chat_completions', { action })).toBeNull();
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
    const response = enkryptGuardrailRejectionResponse(kind, {
      action: 'unavailable',
      reason: 'transient',
    });

    expect(response?.status).toBe(503);
    expect(response?.headers.get('retry-after')).toBe('1');
    expect(response?.headers.get('x-should-retry')).toBeNull();
    expect(await response?.json()).toEqual(body);
  });

  it.each([
    ['timeout', /did not finish checking this request in time.*compact or prune/],
    ['failed', /could not check this request, so it was not sent\. Try again later\.$/],
  ] as const)(
    'tells clients not to retry automatically after a %s failure',
    async (reason, message) => {
      const response = enkryptGuardrailRejectionResponse('chat_completions', {
        action: 'unavailable',
        reason,
      });

      expect(response?.status).toBe(503);
      expect(response?.headers.get('retry-after')).toBeNull();
      expect(response?.headers.get('x-should-retry')).toBe('false');
      expect(await response?.json()).toMatchObject({
        error: { message: expect.stringMatching(message), code: 'guardrail_unavailable' },
      });
    }
  );
});

describe('enkryptOutputGuardrailRejectionResponse', () => {
  const outputBlock = {
    action: 'block',
    message:
      "Your organization's Enkrypt AI guardrail blocked the model's response (detected: pii).",
  } as const;
  const openAiBlocked = {
    error: {
      message: outputBlock.message,
      type: 'invalid_request_error',
      code: 'guardrail_blocked',
      param: null,
    },
    error_type: 'guardrail_blocked',
  };
  const anthropicBlocked = {
    type: 'error',
    error: { type: 'invalid_request_error', message: outputBlock.message },
    error_type: 'guardrail_blocked',
  };

  it.each([
    ['skip', false],
    ['skip', true],
    ['allow', false],
    ['allow', true],
  ] as const)('releases the response on %s (stream: %s)', (action, stream) => {
    expect(enkryptOutputGuardrailRejectionResponse('responses', { action }, stream)).toBeNull();
  });

  it.each([
    ['chat_completions', openAiBlocked],
    ['messages', anthropicBlocked],
    ['responses', openAiBlocked],
  ] as const)('returns a native JSON error for a non-streamed %s block', async (kind, body) => {
    const response = enkryptOutputGuardrailRejectionResponse(kind, outputBlock, false);

    expect(response?.status).toBe(400);
    expect(response?.headers.get('content-type')).toContain('application/json');
    expect(response?.headers.get('x-should-retry')).toBe('false');
    expect(await response?.json()).toEqual(body);
  });

  it.each([
    ['chat_completions', `data: ${JSON.stringify(openAiBlocked)}\n\n`],
    ['messages', `event: error\ndata: ${JSON.stringify(anthropicBlocked)}\n\n`],
    [
      'responses',
      `event: error\ndata: ${JSON.stringify({
        type: 'error',
        sequence_number: 0,
        code: 'guardrail_blocked',
        message: outputBlock.message,
        param: null,
        error: {
          type: 'invalid_request_error',
          code: 'guardrail_blocked',
          message: outputBlock.message,
          param: null,
        },
        error_type: 'guardrail_blocked',
      })}\n\n`,
    ],
  ] as const)('returns one SSE error event for a streamed %s block', async (kind, body) => {
    const response = enkryptOutputGuardrailRejectionResponse(kind, outputBlock, true);

    expect(response?.status).toBe(200);
    expect(response?.headers.get('content-type')).toBe('text/event-stream');
    expect(response?.headers.get('content-encoding')).toBe('identity');
    expect(response?.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response?.headers.get('x-should-retry')).toBe('false');
    expect(await response?.text()).toBe(body);
  });

  it.each([false, true])(
    'returns a retryable error after a transient failure (stream: %s)',
    async stream => {
      const response = enkryptOutputGuardrailRejectionResponse(
        'chat_completions',
        { action: 'unavailable', reason: 'transient' },
        stream
      );

      expect(response?.status).toBe(stream ? 200 : 503);
      expect(response?.headers.get('retry-after')).toBe('1');
      expect(response?.headers.get('x-should-retry')).toBeNull();
      const text = (await response?.text()) ?? '';
      expect(text).toContain(
        "could not check the model's response, so it was withheld. Please retry."
      );
      expect(text).toContain('"code":"guardrail_unavailable"');
    }
  );

  it.each([
    ['timeout', /did not finish checking the model's response in time.*ask for a shorter response/],
    ['failed', /could not check the model's response, so it was withheld\. Try again later\.$/],
  ] as const)(
    'tells clients not to retry automatically after a %s failure',
    async (reason, message) => {
      const response = enkryptOutputGuardrailRejectionResponse(
        'messages',
        { action: 'unavailable', reason },
        false
      );

      expect(response?.status).toBe(503);
      expect(response?.headers.get('retry-after')).toBeNull();
      expect(response?.headers.get('x-should-retry')).toBe('false');
      expect(await response?.json()).toEqual({
        type: 'error',
        error: { type: 'api_error', message: expect.stringMatching(message) },
        error_type: 'guardrail_unavailable',
      });
    }
  );

  it('streams an unavailable error for responses with the top-level and nested error', async () => {
    const response = enkryptOutputGuardrailRejectionResponse(
      'responses',
      { action: 'unavailable', reason: 'failed' },
      true
    );

    expect(response?.headers.get('x-should-retry')).toBe('false');
    const text = (await response?.text()) ?? '';
    expect(text.startsWith('event: error\ndata: ')).toBe(true);
    expect(JSON.parse(text.slice('event: error\ndata: '.length))).toEqual({
      type: 'error',
      sequence_number: 0,
      code: 'guardrail_unavailable',
      message: expect.stringContaining("could not check the model's response"),
      param: null,
      error: {
        type: 'server_error',
        code: 'guardrail_unavailable',
        message: expect.stringContaining("could not check the model's response"),
        param: null,
      },
      error_type: 'guardrail_unavailable',
    });
  });
});
