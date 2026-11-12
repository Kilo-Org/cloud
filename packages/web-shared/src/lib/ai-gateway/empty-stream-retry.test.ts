import { describe, expect, it, jest } from '@jest/globals';
import {
  getEmptyStreamRetryModels,
  isEmptyStreamRetryEnabled,
  isEmptyStreamRetryModelListed,
  maybeRetryEmptyUpstreamStream,
  parseEmptyStreamRetryModels,
  EMPTY_STREAM_RETRY_MODELS_ENV,
  type EmptyStreamRetryEligibility,
} from './empty-stream-retry';
import type { SendUpstreamAttemptResult } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const DONE = 'data: [DONE]\n\n';
const ENVELOPE = `data: ${JSON.stringify({ choices: [], id: 'gen-empty', provider: 'Novita AI' })}\n\n`;
const CONTENT = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' }, index: 0 }], id: 'gen-full' })}\n\n`;

function sseResponse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, status: 200 }
  );
}

function success(text: string): Extract<SendUpstreamAttemptResult, { type: 'success' }> {
  return { response: sseResponse(text), toolsAvailable: [], toolsUsed: [], type: 'success' };
}

function chatRequest(provider?: GatewayRequest['body']['provider']): GatewayRequest {
  return {
    body: {
      messages: [{ content: 'hi', role: 'user' }],
      model: '~deepseek/deepseek-flash-latest',
      provider,
      stream: true,
    },
    kind: 'chat_completions',
  };
}

const eligibility: EmptyStreamRetryEligibility = {
  costLimited: false,
  kind: 'chat_completions',
  model: '~deepseek/deepseek-flash-latest',
  models: parseEmptyStreamRetryModels('~deepseek/*'),
  providerType: 'openrouter',
  streaming: true,
  userByok: false,
};

describe('parseEmptyStreamRetryModels', () => {
  it('reads a comma-separated list of model ids', () => {
    expect(parseEmptyStreamRetryModels(' a/b , c/d ')).toEqual(['a/b', 'c/d']);
  });

  it('is empty for an unset or blank value, which leaves the retry off', () => {
    expect(parseEmptyStreamRetryModels(undefined)).toEqual([]);
    expect(parseEmptyStreamRetryModels('')).toEqual([]);
    expect(parseEmptyStreamRetryModels(' , ')).toEqual([]);
  });

  it('drops duplicates and lowercases every entry', () => {
    expect(parseEmptyStreamRetryModels('A/B,a/b,C/*')).toEqual(['a/b', 'c/*']);
  });

  it('is empty when an entry cannot be a model id', () => {
    expect(parseEmptyStreamRetryModels('a/b,*,$(boom)')).toEqual([]);
  });
});

describe('isEmptyStreamRetryModelListed', () => {
  it('matches an exact id and a trailing-wildcard prefix', () => {
    expect(isEmptyStreamRetryModelListed('a/b', ['a/b'])).toBe(true);
    expect(isEmptyStreamRetryModelListed('~deepseek/deepseek-flash-latest', ['~deepseek/*'])).toBe(
      true
    );
  });

  it('does not match an id outside the list', () => {
    expect(isEmptyStreamRetryModelListed('a/b', ['a/c'])).toBe(false);
    expect(isEmptyStreamRetryModelListed('x~deepseek/a', ['~deepseek/*'])).toBe(false);
  });
});

describe('isEmptyStreamRetryEnabled', () => {
  it('accepts a streaming chat completion for a listed model', () => {
    expect(isEmptyStreamRetryEnabled(eligibility)).toBe(true);
  });

  it('excludes a request paid for by a user key', () => {
    expect(isEmptyStreamRetryEnabled({ ...eligibility, userByok: true })).toBe(false);
  });

  it('excludes a non-streaming request', () => {
    expect(isEmptyStreamRetryEnabled({ ...eligibility, streaming: false })).toBe(false);
  });

  it('excludes a request under a bounded-spend header', () => {
    expect(isEmptyStreamRetryEnabled({ ...eligibility, costLimited: true })).toBe(false);
  });

  it('excludes a model outside the list and an unlisted API shape', () => {
    expect(isEmptyStreamRetryEnabled({ ...eligibility, model: 'other/model' })).toBe(false);
    expect(isEmptyStreamRetryEnabled({ ...eligibility, kind: 'messages' })).toBe(false);
  });

  it('excludes every route whose generation bills a delegated account', () => {
    // A connected ChatGPT subscription, a connected Claude organization, a custom LLM's own
    // credentials, and a user's direct key all serve requests with `userByok` null.
    for (const providerType of [
      'claude-billing',
      'openai-chatgpt',
      'custom',
      'custom-public',
      'direct-byok',
    ] as const) {
      expect(isEmptyStreamRetryEnabled({ ...eligibility, providerType })).toBe(false);
    }
  });

  it('accepts the platform-funded gateways', () => {
    expect(isEmptyStreamRetryEnabled({ ...eligibility, providerType: 'openrouter' })).toBe(true);
    expect(isEmptyStreamRetryEnabled({ ...eligibility, providerType: 'vercel' })).toBe(true);
  });
});

describe('getEmptyStreamRetryModels', () => {
  it('reads the environment variable', () => {
    const previous = process.env[EMPTY_STREAM_RETRY_MODELS_ENV];
    process.env[EMPTY_STREAM_RETRY_MODELS_ENV] = 'a/b';
    try {
      expect(getEmptyStreamRetryModels()).toEqual(['a/b']);
    } finally {
      if (previous === undefined) delete process.env[EMPTY_STREAM_RETRY_MODELS_ENV];
      else process.env[EMPTY_STREAM_RETRY_MODELS_ENV] = previous;
    }
  });
});

describe('maybeRetryEmptyUpstreamStream', () => {
  it('forwards a content-bearing answer without a retry request', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: success(CONTENT + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry: chatRequest(),
      retry,
      vercelRequestId: 'req-1',
    });

    expect(retry).not.toHaveBeenCalled();
    expect(result.emptyStream).toBeNull();
    expect(await result.attempt.response.text()).toBe(CONTENT + DONE);
  });

  it('replaces an envelope-only answer with one retry that carries content', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const requestForRetry = chatRequest();
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry,
      retry,
      vercelRequestId: 'req-2',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(await result.attempt.response.text()).toBe(CONTENT + DONE);
    expect(result.request).toBe(requestForRetry);
    expect(result.emptyStream).toMatchObject({
      provider: 'Novita AI',
      retried: true,
      retryOutcome: 'content',
    });
  });

  it('demotes the provider named by the envelope-only stream', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const requestForRetry = chatRequest({ order: ['novita', 'alibaba'] });
    await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry,
      retry,
      vercelRequestId: null,
    });

    expect(requestForRetry.body.provider).toEqual({
      ignore: ['novita'],
      order: ['alibaba'],
    });
  });

  it('leaves the order untouched when the reported provider is not one of its entries', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const requestForRetry = chatRequest({ order: ['alibaba'] });
    await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry,
      retry,
      vercelRequestId: null,
    });

    expect(requestForRetry.body.provider).toEqual({ order: ['alibaba'] });
  });

  it('demotes within the gateway-configured order when the request carries none', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const requestForRetry = chatRequest();
    await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      configuredProviderOrder: async () => ['novita', 'alibaba'],
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry,
      retry,
      vercelRequestId: null,
    });

    expect(requestForRetry.body.provider).toEqual({ ignore: ['novita'], order: ['alibaba'] });
  });

  it('leaves the order off the retry when the configured order holds only the failed provider', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const requestForRetry = chatRequest();
    await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      configuredProviderOrder: async () => ['novita'],
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry,
      retry,
      vercelRequestId: null,
    });

    expect(requestForRetry.body.provider).toEqual({ ignore: ['novita'] });
  });

  it('keeps a caller-only restriction rather than adding an exclusion to it', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const requestForRetry = chatRequest({ only: ['novita'] });
    await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry,
      retry,
      vercelRequestId: null,
    });

    expect(requestForRetry.body.provider).toEqual({ only: ['novita'] });
  });

  it('leaves a request it cannot retry completely untouched', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const response = sseResponse(ENVELOPE + DONE);
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: { response, toolsAvailable: [], toolsUsed: [], type: 'success' },
      enabled: false,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry: null,
      retry,
      vercelRequestId: 'req-3',
    });

    expect(retry).not.toHaveBeenCalled();
    // No peek: the same response object, with its body still unread and its headers unchanged.
    expect(result.attempt.response).toBe(response);
    expect(result.emptyStream).toBeNull();
    expect(await response.text()).toBe(ENVELOPE + DONE);
  });

  it('forwards the first answer when the retry is envelope-only as well', async () => {
    const retry = jest.fn(async () => success(ENVELOPE + DONE));
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry: chatRequest(),
      retry,
      vercelRequestId: 'req-4',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.emptyStream).toMatchObject({ retried: true, retryOutcome: 'empty' });
    expect(await result.attempt.response.text()).toBe(ENVELOPE + DONE);
  });

  it('forwards the first answer when the retry attempt fails', async () => {
    const retry = jest.fn(async (): Promise<SendUpstreamAttemptResult> => ({
      type: 'unknown-gateway-model',
    }));
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: success(ENVELOPE + DONE),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry: chatRequest(),
      retry,
      vercelRequestId: 'req-5',
    });

    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.emptyStream).toMatchObject({ retried: true, retryOutcome: 'error' });
    expect(result.request).toBeNull();
    expect(await result.attempt.response.text()).toBe(ENVELOPE + DONE);
  });

  it('forwards without a retry when the peek reaches its cap', async () => {
    const retry = jest.fn(async () => success(CONTENT + DONE));
    const text = ENVELOPE + CONTENT + DONE;
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: success(text),
      enabled: true,
      kind: 'chat_completions',
      model: '~deepseek/deepseek-flash-latest',
      peekOptions: { maxEvents: 1 },
      providerType: 'openrouter',
      requestForRetry: chatRequest(),
      retry,
      vercelRequestId: 'req-6',
    });

    expect(retry).not.toHaveBeenCalled();
    expect(result.emptyStream).toBeNull();
    expect(await result.attempt.response.text()).toBe(text);
  });

  it('does not peek another API shape', async () => {
    const response = sseResponse(ENVELOPE + DONE);
    const result = await maybeRetryEmptyUpstreamStream({
      attempt: { response, toolsAvailable: [], toolsUsed: [], type: 'success' },
      enabled: true,
      kind: 'messages',
      model: '~deepseek/deepseek-flash-latest',
      providerType: 'openrouter',
      requestForRetry: {
        body: {
          max_tokens: 16,
          messages: [{ content: 'hi', role: 'user' }],
          model: '~deepseek/deepseek-flash-latest',
        },
        kind: 'messages',
      },
      retry: jest.fn(async () => success(CONTENT + DONE)),
      vercelRequestId: null,
    });

    expect(result.emptyStream).toBeNull();
    expect(result.attempt.response).toBe(response);
  });
});
