import { createServer } from 'node:http';
import { captureException, captureMessage } from '@sentry/nextjs';
import { fetchGeneration } from './upstream-request';
import type { Provider } from './types';
import type { OpenRouterGeneration } from './openrouter/types';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const provider: Provider = {
  type: 'openrouter',
  apiUrl: 'https://openrouter.example/api/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: 'test-api-key',
  apiKeyHeader: null,
  supportedChatApis: [],
  responseTransforms: null,
  transformRequest: async () => {},
};

const generation: OpenRouterGeneration = {
  data: {
    id: 'message-id',
    model: 'test/model',
    created_at: '2026-11-04T00:00:00Z',
    origin: 'https://example.com',
    total_cost: 0.01,
    usage: 0.01,
    is_byok: true,
    upstream_inference_cost: 0.2,
    cache_discount: -0.001,
    native_tokens_prompt: 100,
    native_tokens_completion: 50,
    native_tokens_reasoning: 10,
    native_tokens_cached: 20,
    native_tokens_cache_creation: 30,
    provider_name: 'test-provider',
    upstream_id: 'upstream-id',
    finish_reason: 'stop',
    moderation_latency: null,
    streamed: true,
    cancelled: false,
  },
};
const originalFetch = global.fetch;
const nativeTimeout = AbortSignal.timeout;

function requestSignal(init?: RequestInit): AbortSignal {
  if (!init?.signal) throw new Error('expected a request signal');
  return init.signal;
}

function stalledFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = requestSignal(init);
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

describe('fetchGeneration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.mocked(captureMessage).mockClear();
    jest.mocked(captureException).mockClear();
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it.each(['openrouter', 'vercel'] as const)(
    'returns validated %s generation costs and token data',
    async type => {
      const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json(generation));

      const result = fetchGeneration('message-id', { ...provider, type });
      expect(mockFetch).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(200);

      await expect(result).resolves.toEqual(generation);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.example/api/v1/generation?id=message-id',
        {
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }),
          signal: expect.any(AbortSignal),
        }
      );
      expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
      expect(captureMessage).not.toHaveBeenCalled();
    }
  );

  it('accepts Vercel generation data without OpenRouter origin metadata', async () => {
    const { origin: _origin, ...data } = generation.data;
    jest.spyOn(global, 'fetch').mockResolvedValue(Response.json({ data }));
    const result = fetchGeneration('message-id', { ...provider, type: 'vercel' });
    await jest.advanceTimersByTimeAsync(200);
    await expect(result).resolves.toEqual({ data: { ...data, origin: '' } });
  });

  it('encodes the entire generation ID as one query parameter', async () => {
    const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json(generation));
    const messageId = 'generation/id?x=1&secret=other#fragment +%';
    const result = fetchGeneration(messageId, provider);
    await jest.advanceTimersByTimeAsync(200);
    await result;
    expect(mockFetch.mock.calls[0]?.[0]).toBe(
      `${provider.apiUrl}/generation?id=${encodeURIComponent(messageId)}`
    );
  });

  it('allows a slow healthy lookup to finish within its attempt budget', async () => {
    const mockFetch = jest.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      await new Promise(resolve => setTimeout(resolve, 8_000));
      const signal = requestSignal(init);
      return new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(generation)));
              controller.close();
            }, 1_000);
          },
        })
      );
    });
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(9_200);

    await expect(result).resolves.toEqual(generation);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it.each([404, 429, 500])(
    'retries HTTP %s while generation data becomes available',
    async status => {
      const response = new Response('private provider error body', { status });
      const cancel = jest.spyOn(response.body!, 'cancel');
      const mockFetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(Response.json(generation));
      const result = fetchGeneration('message-id', provider);

      await jest.advanceTimersByTimeAsync(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(4_999);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual(generation);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(requestSignal(mockFetch.mock.calls[0]?.[1])).not.toBe(
        requestSignal(mockFetch.mock.calls[1]?.[1])
      );
      expect(captureMessage).not.toHaveBeenCalled();
    }
  );

  it('bounds stalled fetch attempts and retries before returning the usage fallback', async () => {
    const mockFetch = jest.spyOn(global, 'fetch').mockImplementation(stalledFetch);
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(75_000);

    await expect(result).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(AbortSignal.timeout).toHaveBeenCalledTimes(4);
    for (const [, init] of mockFetch.mock.calls) expect(requestSignal(init).aborted).toBe(true);
    expect(captureMessage).toHaveBeenCalledWith('Generation lookup failed', {
      level: 'info',
      tags: { source: 'openrouter_generation_fetch' },
      extra: { messageId: 'message-id', reason: 'request_timeout', status: undefined },
    });
  });

  it('bounds stalled successful response bodies with the same attempt signal', async () => {
    const signals: AbortSignal[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_input, init) => {
      const signal = requestSignal(init);
      signals.push(signal);
      const body = new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body);
    });
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(75_000);

    await expect(result).resolves.toBeUndefined();
    expect(signals).toHaveLength(4);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(captureMessage).toHaveBeenCalledWith(
      'Generation lookup failed',
      expect.objectContaining({
        extra: { messageId: 'message-id', reason: 'request_timeout', status: 200 },
      })
    );
  });

  it('recovers from a transient body read failure before retrying', async () => {
    const brokenResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('private body read failure'));
        },
      })
    );
    const mockFetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(brokenResponse)
      .mockResolvedValueOnce(Response.json(generation));
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(5_200);

    await expect(result).resolves.toEqual(generation);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('includes failed requests, backoff, and the initial delay in the 75s budget', async () => {
    const attemptsAt: number[] = [];
    const mockFetch = jest.spyOn(global, 'fetch').mockImplementation(() => {
      attemptsAt.push(performance.now());
      return new Promise(resolve => {
        setTimeout(() => resolve(new Response(null, { status: 404 })), 9_000);
      });
    });
    const result = fetchGeneration('message-id', provider);
    let completedAt: number | undefined;
    void result.then(() => {
      completedAt = performance.now();
    });
    await jest.advanceTimersByTimeAsync(75_000);

    await expect(result).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(attemptsAt).toEqual([200, 14_200, 30_700, 50_950]);
    expect(completedAt).toBeLessThanOrEqual(75_000);
  });

  it('clamps the last attempt including its body to the time left after retry delays', async () => {
    let attempts = 0;
    const mockFetch = jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
      if (++attempts === 6) {
        const signal = requestSignal(init);
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true,
                });
              },
            })
          )
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    const result = fetchGeneration('message-id', provider);
    let completedAt: number | undefined;
    void result.then(() => {
      completedAt = performance.now();
    });
    await jest.advanceTimersByTimeAsync(75_000);

    await expect(result).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(6);
    const lastTimeout = jest.mocked(AbortSignal.timeout).mock.calls.at(-1)?.[0];
    expect(lastTimeout).toBeGreaterThan(8_000);
    expect(lastTimeout).toBeLessThan(10_000);
    expect(completedAt).toBeGreaterThanOrEqual(74_999);
    expect(completedAt).toBeLessThanOrEqual(75_000);
  });

  it.each([
    null,
    {},
    { data: {} },
    { data: { ...generation.data, total_cost: '0.01' } },
    { data: { ...generation.data, model: null } },
    { data: { ...generation.data, native_tokens_prompt: '100' } },
    { data: { ...generation.data, is_byok: 'false' } },
  ])('falls back immediately for an invalid external payload: %j', async payload => {
    const mockFetch = jest.spyOn(global, 'fetch').mockResolvedValue(Response.json(payload));
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith(
      'Generation lookup failed',
      expect.objectContaining({
        extra: { messageId: 'message-id', reason: 'invalid_payload', status: 200 },
      })
    );
  });

  it('recovers from malformed JSON without logging provider content', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('private malformed JSON body'));
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(200);

    await expect(result).resolves.toBeUndefined();
    expect(captureMessage).toHaveBeenCalledWith('Generation lookup failed', {
      level: 'info',
      tags: { source: 'openrouter_generation_fetch' },
      extra: { messageId: 'message-id', reason: 'invalid_json', status: 200 },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('never logs raw network errors, provider status text, or error bodies', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValueOnce(new Error('private network error with credentials'))
      .mockImplementation(
        async () =>
          new Response('private error body', { status: 500, statusText: 'private status text' })
      );
    const result = fetchGeneration('message-id', provider);
    await jest.advanceTimersByTimeAsync(75_000);

    await expect(result).resolves.toBeUndefined();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledWith('Generation lookup failed', {
      level: 'info',
      tags: { source: 'openrouter_generation_fetch' },
      extra: { messageId: 'message-id', reason: 'http_error', status: 500 },
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each(['headers', 'body'] as const)('aborts a real HTTP fetch stalled at %s', async phase => {
    jest.useRealTimers();
    jest.mocked(AbortSignal.timeout).mockImplementation(() => nativeTimeout(100));
    jest.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(74_000);
    let receivedHeaders = false;
    const server = createServer((_request, response) => {
      if (phase === 'body') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.flushHeaders();
        response.write('{"data":');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('expected a server port');
      jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const response = await originalFetch(input, init);
        receivedHeaders = true;
        return response;
      });
      await expect(
        fetchGeneration('message-id', { ...provider, apiUrl: `http://127.0.0.1:${address.port}` })
      ).resolves.toBeUndefined();

      expect(receivedHeaders).toBe(phase === 'body');
      expect(AbortSignal.timeout).toHaveBeenCalledWith(1_000);
      expect(captureMessage).toHaveBeenCalledWith(
        'Generation lookup failed',
        expect.objectContaining({ extra: expect.objectContaining({ reason: 'request_timeout' }) })
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  });
});
