jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USAGE_INGEST_URL: 'https://usage.example.test/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publisher-secret',
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { captureException } from '@sentry/nextjs';
import { createServer } from 'node:http';
import {
  enqueueEnkryptUsage,
  enqueueUsage,
  USAGE_ENQUEUE_TIMEOUT_MS,
  USAGE_ENQUEUE_MAX_ATTEMPTS,
  USAGE_ENQUEUE_RETRY_TIMEOUT_MS,
  USAGE_ENQUEUE_RETRY_BUDGET_MS,
  USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS,
} from './usage-publisher';
import type {
  EnkryptUsageWriteInput,
  LlmUsageQueueMessage,
  UsageRecordRequest,
} from '@kilocode/usage-contracts';
import type * as UsagePublisherModule from './usage-publisher';

const payload: LlmUsageQueueMessage = {
  core: {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    kilo_user_id: 'oauth/synthetic',
    cost: 1234,
    input_tokens: 10,
    output_tokens: 20,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: '2026-08-05T10:11:12.945Z',
    provider: 'openrouter',
    model: 'synthetic-model',
    requested_model: 'synthetic-model',
    cache_discount: null,
    has_error: false,
    abuse_classification: 0,
    organization_id: null,
    inference_provider: null,
    project_id: null,
  },
  metadata: {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    message_id: 'msg-1',
    created_at: '2026-08-05T10:11:12.945Z',
    http_x_forwarded_for: null,
    http_x_vercel_ip_city: null,
    http_x_vercel_ip_country: null,
    http_x_vercel_ip_latitude: null,
    http_x_vercel_ip_longitude: null,
    http_x_vercel_ja4_digest: null,
    user_prompt_prefix: '🙂',
    system_prompt_prefix: null,
    system_prompt_length: null,
    http_user_agent: null,
    max_tokens: null,
    has_middle_out_transform: null,
    status_code: 200,
    upstream_id: null,
    finish_reason: 'stop',
    latency: null,
    moderation_latency: null,
    generation_time: null,
    is_byok: null,
    is_user_byok: false,
    streamed: null,
    cancelled: null,
    editor_name: null,
    api_kind: 'chat_completions',
    has_tools: null,
    machine_id: null,
    feature: null,
    session_id: null,
    mode: null,
    auto_model: null,
    reasoning_setting: 'medium',
    inference_region: 'eu',
    market_cost: null,
    non_inference_cost: null,
    is_free: null,
    abuse_delay: null,
    abuse_downgraded_from: null,
  },
  prior_microdollar_usage: 0,
  posthog_distinct_id: null,
};

const config = jest.requireMock<{
  USAGE_INGEST_URL: string;
  USAGE_INGEST_PUBLISH_SECRET: string;
}>('@kilocode/web-shared/lib/config.server');
const mockFetch = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
const nativeFetch = globalThis.fetch;
const originalRegion = process.env.VERCEL_REGION;
let warn: jest.SpiedFunction<typeof console.warn>;
let info: jest.SpiedFunction<typeof console.info>;

beforeEach(() => {
  delete process.env.VERCEL_REGION;
  config.USAGE_INGEST_URL = 'https://usage.example.test/usage';
  config.USAGE_INGEST_PUBLISH_SECRET = 'synthetic-publisher-secret';
  mockFetch.mockReset();
  jest.mocked(captureException).mockClear();
  jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  if (originalRegion === undefined) delete process.env.VERCEL_REGION;
  else process.env.VERCEL_REGION = originalRegion;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function expectUnavailableWarning(
  reason: string,
  duplicatePossible = false,
  configured: { url?: string; secret?: string } = {
    url: config.USAGE_INGEST_URL,
    secret: config.USAGE_INGEST_PUBLISH_SECRET,
  }
) {
  expect(warn.mock.calls).toEqual([
    [
      'usage enqueue unavailable',
      {
        usageId: payload.core.id,
        execution_region: 'unknown',
        kind: 'unavailable',
        reason,
        ...(duplicatePossible && { duplicate_possible: true }),
      },
    ],
  ]);
  const logged = JSON.stringify(warn.mock.calls);
  if (configured.url) expect(logged).not.toContain(configured.url);
  if (configured.secret) expect(logged).not.toContain(configured.secret);
  expect(logged).not.toMatch(/Bearer|sensitive|prompt|metadata/);
}

describe('enqueueUsage', () => {
  test.each([
    ['fra1', 'fra1'],
    ['sfo1', 'sfo1'],
    ['lhr1', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('logs execution region %s as %s on retries and terminal failure', async (region, expected) => {
    if (region === undefined) delete process.env.VERCEL_REGION;
    else process.env.VERCEL_REGION = region;
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const work = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await work).toEqual({ kind: 'unavailable', reason: 'http_401' });
    expect(warn.mock.calls).toEqual([
      [
        'usage enqueue retrying',
        { usageId: payload.core.id, execution_region: expected, reason: 'http_429', attempt: 1 },
      ],
      [
        'usage enqueue unavailable',
        {
          usageId: payload.core.id,
          execution_region: expected,
          kind: 'unavailable',
          reason: 'http_401',
        },
      ],
    ]);
    expect(mockFetch.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify(payload),
      JSON.stringify(payload),
    ]);
  });
  test('preserves the complete payload and ID with dedicated publisher authentication', async () => {
    const event = {
      ...payload,
      bouncer_usage_event: { request_id: 'synthetic-request', payload: { cost: 1234 } },
    } satisfies LlmUsageQueueMessage;
    const response = new Response(null, { status: 202 });
    const read = jest.spyOn(response, 'text');
    mockFetch.mockResolvedValue(response);
    const timeout = jest.spyOn(AbortSignal, 'timeout');

    expect(await enqueueUsage(event)).toEqual({ kind: 'accepted' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://usage.example.test/usage', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer synthetic-publisher-secret',
      },
      body: JSON.stringify(event),
      signal: expect.any(AbortSignal),
      cache: 'no-store',
      redirect: 'manual',
    });
    expect(timeout).toHaveBeenCalledWith(USAGE_ENQUEUE_TIMEOUT_MS);
    expect(read).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(['USAGE_INGEST_URL', 'USAGE_INGEST_PUBLISH_SECRET'] as const)(
    'reports publisher_not_configured without %s and makes no network call',
    async key => {
      config[key] = '';
      expect(await enqueueUsage(payload)).toEqual({
        kind: 'unavailable',
        reason: 'publisher_not_configured',
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expectUnavailableWarning('publisher_not_configured');
    }
  );

  test.each([
    'malformed-sensitive-url',
    // `new URL` accepts these as non-http schemes, so only the protocol check rejects them.
    'localhost:3000/usage',
    'usage.example.test:8080/usage',
    'ftp://usage.example.test/usage',
    'unix:/tmp/usage.sock',
  ])('treats a non-http publisher URL as an unstarted publication: %s', async value => {
    config.USAGE_INGEST_URL = value;
    expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'unavailable',
      reason: 'publisher_not_configured',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expectUnavailableWarning('publisher_not_configured');
  });

  test('uses the configured URL without an additional path, query or fragment policy', async () => {
    config.USAGE_INGEST_URL = 'https://usage.example.test/proxy/usage?fixture=synthetic#fragment';
    mockFetch.mockResolvedValue(new Response(null, { status: 202 }));
    expect(await enqueueUsage(payload)).toEqual({ kind: 'accepted' });
    expect(mockFetch).toHaveBeenCalledWith(config.USAGE_INGEST_URL, expect.any(Object));
  });

  test('preserves confirmed acceptance when unused response-body cleanup fails', async () => {
    const cancel = jest.fn(() => {
      throw new Error('sensitive cleanup error');
    });
    const body = new ReadableStream({ cancel });
    mockFetch.mockResolvedValue(new Response(body, { status: 202 }));

    expect(await enqueueUsage(payload)).toEqual({ kind: 'accepted' });
    // Allow a rejected cancellation promise to surface as an unhandled rejection.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([200, 204, 401, 503])(
    'reports HTTP %i without retrying or reading its body',
    async status => {
      const response = new Response(status === 204 ? null : 'sensitive-upstream-body', { status });
      const read = jest.spyOn(response, 'text');
      const cancel = response.body ? jest.spyOn(response.body, 'cancel') : null;
      mockFetch.mockResolvedValue(response);
      const outcome = { kind: 'unavailable', reason: `http_${status}` };
      expect(await enqueueUsage(payload)).toEqual(outcome);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      if (cancel) expect(cancel).toHaveBeenCalledTimes(1);
      expectUnavailableWarning(outcome.reason, status >= 500);
    }
  );

  test('bounds a real HTTP request that never responds to two seconds', async () => {
    let requests = 0;
    const server = createServer(() => {
      requests++;
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
      mockFetch.mockImplementation(nativeFetch);
      const start = performance.now();
      expect(await enqueueUsage(payload)).toEqual({ kind: 'unavailable', reason: 'timeout' });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(USAGE_ENQUEUE_TIMEOUT_MS - 100);
      expect(elapsed).toBeLessThan(USAGE_ENQUEUE_TIMEOUT_MS + 1_000);
      expect(requests).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expectUnavailableWarning('timeout', true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  });

  test('contains network failures and emits only the ID and categorical outcome', async () => {
    const error = Object.assign(new Error('synthetic-publisher-secret sensitive prompt'), {
      name: 'sensitive-error-name',
    });
    mockFetch.mockRejectedValue(error);
    expect(await enqueueUsage(payload)).toEqual({
      kind: 'unavailable',
      reason: 'request_failed',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expectUnavailableWarning('request_failed', true);
  });
});

describe('enqueueUsage transient retries', () => {
  test.each([408, 429, 500, 502, 503, 504, 'network'])(
    'recovers from %s with the identical serialized event and fresh timeout',
    async failure => {
      jest.useFakeTimers();
      jest.spyOn(Math, 'random').mockReturnValue(0);
      const timeouts = jest.spyOn(AbortSignal, 'timeout');
      if (typeof failure === 'number')
        mockFetch.mockResolvedValueOnce(new Response('sensitive body', { status: failure }));
      else mockFetch.mockRejectedValueOnce(new Error('sensitive network error'));
      mockFetch.mockResolvedValue(new Response(null, { status: 202 }));
      const result = enqueueUsage(payload, { retryTransientFailures: true });
      await jest.runAllTimersAsync();
      expect(await result).toEqual({ kind: 'accepted' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      for (const [url, init] of mockFetch.mock.calls) {
        expect(url).toBe(config.USAGE_INGEST_URL);
        expect(init?.body).toBe(JSON.stringify(payload));
      }
      expect(mockFetch.mock.calls[0][1]?.signal).not.toBe(mockFetch.mock.calls[1][1]?.signal);
      expect(timeouts.mock.calls).toEqual([
        [USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS],
        [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
      ]);
      expect(warn.mock.calls).toEqual([
        [
          'usage enqueue retrying',
          {
            usageId: payload.core.id,
            execution_region: 'unknown',
            reason: failure === 'network' ? 'request_failed' : `http_${failure}`,
            attempt: 1,
            ...(failure !== 408 && failure !== 429 && { duplicate_possible: true }),
          },
        ],
      ]);
    }
  );

  test.each([200, 204, 301, 400, 401, 403, 404, 422])(
    'does not retry permanent or unexpected HTTP %i',
    async status => {
      mockFetch.mockResolvedValue(
        new Response(status === 204 ? null : 'sensitive body', { status })
      );
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'unavailable',
        reason: `http_${status}`,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expectUnavailableWarning(`http_${status}`);
    }
  );

  test.each(['USAGE_INGEST_URL', 'USAGE_INGEST_PUBLISH_SECRET'] as const)(
    'does not attempt or retry missing %s',
    async key => {
      const configured = { ...config };
      config[key] = '';
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'unavailable',
        reason: 'publisher_not_configured',
      });
      expect(mockFetch).not.toHaveBeenCalled();
      // Check the value that is still set; the emptied one would match any string.
      expectUnavailableWarning('publisher_not_configured', false, {
        url: key === 'USAGE_INGEST_URL' ? undefined : configured.USAGE_INGEST_URL,
        secret:
          key === 'USAGE_INGEST_PUBLISH_SECRET'
            ? undefined
            : configured.USAGE_INGEST_PUBLISH_SECRET,
      });
    }
  );

  test('waits for capped exponential full-jitter boundaries before each fetch', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    for (const [delay, count] of [
      [250, 2],
      [500, 3],
      [1000, 4],
    ]) {
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(mockFetch).toHaveBeenCalledTimes(count - 1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(count);
    }
    expect(await result).toEqual({ kind: 'unavailable', reason: 'http_503' });
  });

  test.each(
    [301, 302, 303, 307, 308].flatMap(status =>
      [false, true].map(retryTransientFailures => ({ status, retryTransientFailures }))
    )
  )(
    'real HTTP $status is terminal and never follows its target (retries=$retryTransientFailures)',
    async ({ status, retryTransientFailures }) => {
      let targetRequests = 0;
      const received: {
        method: string | undefined;
        authorization: string | undefined;
        body: string;
      }[] = [];
      const target = createServer((_request, response) => {
        targetRequests++;
        response.writeHead(202);
        response.end();
      });
      let targetUrl = '';
      const publisher = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => {
          body += chunk;
        });
        request.on('end', () => {
          received.push({
            method: request.method,
            authorization: request.headers.authorization,
            body,
          });
          response.writeHead(status, { Location: targetUrl });
          response.end('sensitive-upstream-redirect-body');
        });
      });
      try {
        await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
        const targetAddress = target.address();
        if (!targetAddress || typeof targetAddress === 'string')
          throw new Error('Missing target port');
        targetUrl = `http://127.0.0.1:${targetAddress.port}/sensitive-redirect-target`;
        await new Promise<void>(resolve => publisher.listen(0, '127.0.0.1', resolve));
        const address = publisher.address();
        if (!address || typeof address === 'string') throw new Error('Missing publisher port');
        config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
        mockFetch.mockImplementation(nativeFetch);
        expect(await enqueueUsage(payload, { retryTransientFailures })).toEqual({
          kind: 'unavailable',
          reason: `http_${status}`,
        });
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(received).toEqual([
          {
            method: 'POST',
            authorization: `Bearer ${config.USAGE_INGEST_PUBLISH_SECRET}`,
            body: JSON.stringify(payload),
          },
        ]);
        expect(targetRequests).toBe(0);
        expectUnavailableWarning(`http_${status}`);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(targetUrl);
      } finally {
        await Promise.all(
          [publisher, target].map(async server => {
            server.closeAllConnections();
            if (server.listening)
              await new Promise<void>((resolve, reject) =>
                server.close(error => (error ? reject(error) : resolve()))
              );
          })
        );
      }
    }
  );

  test('bounds retries and backoff, preserves bytes, and logs safe categorical outcomes', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const delays = jest.spyOn(globalThis, 'setTimeout');
    const event = { ...payload, core: { ...payload.core } };
    const originalBody = JSON.stringify(event);
    mockFetch.mockImplementation(async () => {
      event.core.cost++;
      throw new Error('synthetic-publisher-secret sensitive prompt');
    });
    const result = enqueueUsage(event, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    expect(mockFetch).toHaveBeenCalledTimes(USAGE_ENQUEUE_MAX_ATTEMPTS);
    expect(mockFetch.mock.calls.map(([, init]) => init?.body)).toEqual(
      Array(USAGE_ENQUEUE_MAX_ATTEMPTS).fill(originalBody)
    );
    expect(delays.mock.calls.map(([, delay]) => delay)).toEqual([250, 500, 1000]);
    expect(warn.mock.calls).toEqual([
      [
        'usage enqueue retrying',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          reason: 'request_failed',
          attempt: 1,
          duplicate_possible: true,
        },
      ],
      [
        'usage enqueue retrying',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          reason: 'request_failed',
          attempt: 2,
          duplicate_possible: true,
        },
      ],
      [
        'usage enqueue retrying',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          reason: 'request_failed',
          attempt: 3,
          duplicate_possible: true,
        },
      ],
      [
        'usage enqueue unavailable',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          kind: 'unavailable',
          reason: 'request_failed',
          duplicate_possible: true,
        },
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|sensitive|prompt|metadata|https/);
  });

  test('stops immediately if a retry receives an authentication failure', async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'http_401' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('usage enqueue unavailable', {
      usageId: payload.core.id,
      execution_region: 'unknown',
      kind: 'unavailable',
      reason: 'http_401',
      duplicate_possible: true,
    });
  });

  test('never marks exhausted 408/429 refusals as possible duplicates', async () => {
    jest.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 408 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValue(new Response(null, { status: 408 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'http_408' });
    expect(mockFetch).toHaveBeenCalledTimes(USAGE_ENQUEUE_MAX_ATTEMPTS);
    expect(warn.mock.calls).toEqual([
      [
        'usage enqueue retrying',
        { usageId: payload.core.id, execution_region: 'unknown', reason: 'http_408', attempt: 1 },
      ],
      [
        'usage enqueue retrying',
        { usageId: payload.core.id, execution_region: 'unknown', reason: 'http_429', attempt: 2 },
      ],
      [
        'usage enqueue retrying',
        { usageId: payload.core.id, execution_region: 'unknown', reason: 'http_408', attempt: 3 },
      ],
      [
        'usage enqueue unavailable',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          kind: 'unavailable',
          reason: 'http_408',
        },
      ],
    ]);
  });

  test.each(['drop', 'timeout'])(
    'retries real HTTP ambiguous acceptance (%s) with identical IDs and body',
    async failure => {
      const bodies: string[] = [];
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => {
          body += chunk;
        });
        request.on('end', () => {
          bodies.push(body);
          if (bodies.length === 1) {
            if (failure === 'drop') request.socket.destroy();
          } else {
            response.writeHead(202);
            response.end();
          }
        });
      });
      try {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Missing fixture port');
        config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
        mockFetch.mockImplementation(nativeFetch);
        expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
          kind: 'accepted',
        });
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(bodies).toEqual([JSON.stringify(payload), JSON.stringify(payload)]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith('usage enqueue retrying', {
          usageId: payload.core.id,
          execution_region: 'unknown',
          reason: failure === 'timeout' ? 'timeout' : 'request_failed',
          attempt: 1,
          duplicate_possible: true,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      }
    },
    30_000
  );

  test('exhausts four real HTTP timeouts within the bounded attempt/backoff budget', async () => {
    let requests = 0;
    const server = createServer(() => {
      requests++;
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
      mockFetch.mockImplementation(nativeFetch);
      const start = performance.now();
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'unavailable',
        reason: 'timeout',
      });
      const elapsed = performance.now() - start;
      // The first timeout is longer and the last attempt is shortened by the budget, so the
      // four-attempt cap does not promise four full per-attempt windows.
      expect(elapsed).toBeGreaterThanOrEqual(
        USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS + USAGE_ENQUEUE_RETRY_TIMEOUT_MS * 2
      );
      expect(elapsed).toBeLessThan(USAGE_ENQUEUE_RETRY_BUDGET_MS + 1_000);
      expect(requests).toBe(USAGE_ENQUEUE_MAX_ATTEMPTS);
      expect(mockFetch).toHaveBeenCalledTimes(USAGE_ENQUEUE_MAX_ATTEMPTS);
      expect(
        warn.mock.calls.filter(([message]) => message === 'usage enqueue retrying')
      ).toHaveLength(3);
      expect(warn).toHaveBeenLastCalledWith('usage enqueue unavailable', {
        usageId: payload.core.id,
        execution_region: 'unknown',
        kind: 'unavailable',
        reason: 'timeout',
        duplicate_possible: true,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  }, 60_000);
});

describe('bounded CF confirmation policy', () => {
  /**
   * Holds each response for a fixed time. `requestAborted` records a client abort while the
   * fixture still owned the response, so a fetch that ignored its signal could not pass.
   */
  function createDelayedServer(responseDelayMs: number) {
    const received: string[] = [];
    const requestAborted: boolean[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => {
        body += chunk;
      });
      request.on('end', () => {
        received.push(body);
        const index = received.length - 1;
        requestAborted[index] = false;
        let finished = false;
        request.socket.once('close', () => {
          if (!finished) requestAborted[index] = true;
        });
        setTimeout(() => {
          if (response.destroyed) return;
          finished = true;
          response.writeHead(202);
          response.end();
        }, responseDelayMs);
      });
    });
    return { server, received, requestAborted };
  }

  async function withDelayedServer<T>(
    responseDelayMs: number,
    work: (fixture: ReturnType<typeof createDelayedServer>) => Promise<T>
  ): Promise<T> {
    const fixture = createDelayedServer(responseDelayMs);
    try {
      await new Promise<void>(resolve => fixture.server.listen(0, '127.0.0.1', resolve));
      const address = fixture.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
      mockFetch.mockImplementation(nativeFetch);
      return await work(fixture);
    } finally {
      fixture.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        fixture.server.close(error => (error ? reject(error) : resolve()))
      );
    }
  }

  test('accepts a 15-second first confirmation within the 20-second window with one fetch', async () => {
    expect(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS).toBe(20_000);
    expect(USAGE_ENQUEUE_RETRY_BUDGET_MS).toBe(40_000);
    await withDelayedServer(15_000, async ({ received, requestAborted }) => {
      const start = performance.now();
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'accepted',
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(15_000);
      expect(elapsed).toBeLessThan(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS);
      expect(received).toEqual([JSON.stringify(payload)]);
      expect(requestAborted).toEqual([false]);
      // The one send is asserted above; `mockFetch` also counts calls made by earlier tests.
      expect(warn).not.toHaveBeenCalled();
    });
  }, 40_000);

  test('a first confirmation after the 10 s policy still accepts on the one send', async () => {
    await withDelayedServer(12_000, async ({ received, requestAborted }) => {
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'accepted',
      });
      expect(received).toHaveLength(1);
      expect(requestAborted).toEqual([false]);
      // The one send is asserted above; `mockFetch` also counts calls made by earlier tests.
      expect(warn).not.toHaveBeenCalled();
    });
  }, 40_000);

  test('a first send that is lost after its 20 s window recovers only on the retry', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const bodies: { body: string; at: number }[] = [];
    const start = performance.now();
    const publisher = createServer((request, response) => {
      let body = '';
      request.on('data', chunk => {
        body += chunk;
      });
      request.on('end', () => {
        bodies.push({ body, at: performance.now() - start });
        // The first send is lost: the fixture never answers it, so only the 20 s window ends it.
        if (bodies.length > 1) {
          response.writeHead(202);
          response.end();
        }
      });
    });
    try {
      await new Promise<void>(resolve => publisher.listen(0, '127.0.0.1', resolve));
      const address = publisher.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
      mockFetch.mockImplementation(nativeFetch);
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'accepted',
      });
      const elapsed = performance.now() - start;
      // The old policy retried at 10 s. The lost send now waits for its full 20 s window, so the
      // recovered second send starts no earlier than that.
      expect(bodies).toHaveLength(2);
      expect(bodies[0].body).toBe(JSON.stringify(payload));
      expect(bodies[1].body).toBe(JSON.stringify(payload));
      expect(bodies[1].at).toBeGreaterThanOrEqual(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS);
      expect(elapsed).toBeGreaterThanOrEqual(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS);
      expect(elapsed).toBeLessThan(USAGE_ENQUEUE_RETRY_BUDGET_MS);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('usage enqueue retrying', {
        usageId: payload.core.id,
        execution_region: 'unknown',
        reason: 'timeout',
        attempt: 1,
        duplicate_possible: true,
      });
    } finally {
      publisher.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        publisher.close(error => (error ? reject(error) : resolve()))
      );
    }
  }, 40_000);

  test('a first confirmation after eight seconds still accepts with one fetch', async () => {
    let requests = 0;
    const publisher = createServer((request, response) => {
      requests++;
      request.resume();
      request.on('end', () => {
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(202);
          response.end();
        }, 8_000);
      });
    });
    try {
      await new Promise<void>(resolve => publisher.listen(0, '127.0.0.1', resolve));
      const address = publisher.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port');
      config.USAGE_INGEST_URL = `http://127.0.0.1:${address.port}/usage`;
      mockFetch.mockImplementation(nativeFetch);
      const start = performance.now();
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'accepted',
      });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(8_000);
      expect(elapsed).toBeLessThan(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS);
      expect(requests).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      publisher.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        publisher.close(error => (error ? reject(error) : resolve()))
      );
    }
  }, 30_000);

  test('waits beyond the single-attempt window for the first confirmation', async () => {
    jest.useFakeTimers();
    const confirmationMs = USAGE_ENQUEUE_TIMEOUT_MS + 1_000;
    expect(confirmationMs).toBeLessThan(USAGE_ENQUEUE_RETRY_TIMEOUT_MS);
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const confirmation = setTimeout(
            () => resolve(new Response(null, { status: 202 })),
            confirmationMs
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(confirmation);
              reject(new Error('synthetic timeout'));
            },
            { once: true }
          );
        })
    );
    let settled = false;
    const result = enqueueUsage(payload, { retryTransientFailures: true }).then(outcome => {
      settled = true;
      return outcome;
    });
    await jest.advanceTimersByTimeAsync(USAGE_ENQUEUE_TIMEOUT_MS);
    expect(settled).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(confirmationMs - USAGE_ENQUEUE_TIMEOUT_MS);
    expect(await result).toEqual({ kind: 'accepted' });
    expect(timeouts.mock.calls).toEqual([[USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS]]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  test('recovers on the fourth attempt and never issues a fifth', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(new Set(mockFetch.mock.calls.map(([, init]) => init?.body))).toEqual(
      new Set([JSON.stringify(payload)])
    );
  });

  test('four full windows plus near-maximum jitter fit inside 40 seconds', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), {
            once: true,
          });
        })
    );
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(mockFetch).toHaveBeenCalledTimes(4);
    // 20 + 5 + 5 + 5 s of windows plus under 3.5 s of backoff stays under 38.5 s, so without a
    // runtime delay the budget clips nothing and every attempt keeps its full window.
    expect(timeouts.mock.calls).toEqual([
      [USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
    ]);
    expect(performance.now()).toBeGreaterThan(38_000);
    expect(performance.now()).toBeLessThan(38_500);
    expect(warn).toHaveBeenLastCalledWith(
      'usage enqueue unavailable',
      expect.objectContaining({ duplicate_possible: true })
    );
  });

  test('clips a later attempt timeout to the remaining elapsed budget', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const timeouts = jest.spyOn(AbortSignal, 'timeout');
    mockFetch
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(38_000);
        return new Response(null, { status: 503 });
      })
      .mockResolvedValue(new Response(null, { status: 202 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });
    expect(timeouts.mock.calls).toEqual([[USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS], [1_750]]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a never-answering first attempt still spends its full twenty seconds before retrying', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mockFetch
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), {
              once: true,
            });
          })
      )
      .mockResolvedValue(new Response(null, { status: 202 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.advanceTimersByTimeAsync(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS - 500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });
    expect(timeouts.mock.calls).toEqual([
      [USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith('usage enqueue retrying', {
      usageId: payload.core.id,
      execution_region: 'unknown',
      reason: 'timeout',
      attempt: 1,
      duplicate_possible: true,
    });
  });

  test('a stalled runtime clips a later attempt to the remaining budget', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    let attempt = 0;
    mockFetch.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          attempt++;
          // A runtime delay pushes the fourth attempt's start, so it is clipped to what remains.
          if (attempt === 3) jest.advanceTimersByTime(10_000);
          if (init?.signal?.aborted) return reject(new Error('synthetic timeout'));
          init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), {
            once: true,
          });
        })
    );
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    const timeoutMs = jest.mocked(AbortSignal.timeout).mock.calls.map(([ms]) => ms);
    expect(timeoutMs[0]).toBe(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS);
    expect(timeoutMs[1]).toBe(USAGE_ENQUEUE_RETRY_TIMEOUT_MS);
    // The fourth attempt is clipped to the remaining budget instead of a full 5 s window.
    expect(timeoutMs).toHaveLength(USAGE_ENQUEUE_MAX_ATTEMPTS);
    expect(mockFetch).toHaveBeenCalledTimes(USAGE_ENQUEUE_MAX_ATTEMPTS);
    const clipped = timeoutMs.slice(1);
    expect(clipped.at(-1)).toBeLessThan(USAGE_ENQUEUE_RETRY_TIMEOUT_MS);
    expect(clipped.at(-1)).toBeGreaterThan(0);
    expect(performance.now()).toBeLessThanOrEqual(USAGE_ENQUEUE_RETRY_BUDGET_MS);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a runtime stall spends the budget so no later attempt starts', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mockFetch.mockImplementation((_url, init) => {
      const attempt = mockFetch.mock.calls.length;
      // A runtime stall during the second attempt spends the rest of the budget, so no later
      // attempt can start and the first attempt keeps its full 20 s window.
      if (attempt === 2) jest.advanceTimersByTime(32_000);
      return new Promise((_resolve, reject) => {
        // The abort may already have happened during the stall above.
        if (init?.signal?.aborted) return reject(new Error('synthetic timeout'));
        init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), {
          once: true,
        });
      });
    });
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'timeout' });
    const timeoutMs = jest.mocked(AbortSignal.timeout).mock.calls.map(([ms]) => ms);
    expect(timeoutMs).toEqual([
      USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS,
      USAGE_ENQUEUE_RETRY_TIMEOUT_MS,
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenLastCalledWith(
      'usage enqueue unavailable',
      expect.objectContaining({ reason: 'timeout', duplicate_possible: true })
    );
  });

  test('fast failures keep the four-attempt cap without starting a fifth', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'http_503' });
    expect(mockFetch).toHaveBeenCalledTimes(USAGE_ENQUEUE_MAX_ATTEMPTS);
    expect(jest.getTimerCount()).toBe(0);
    expect(
      warn.mock.calls.filter(([message]) => message === 'usage enqueue retrying')
    ).toHaveLength(USAGE_ENQUEUE_MAX_ATTEMPTS - 1);
    expect(warn).toHaveBeenLastCalledWith('usage enqueue unavailable', {
      usageId: payload.core.id,
      execution_region: 'unknown',
      kind: 'unavailable',
      reason: 'http_503',
      duplicate_possible: true,
    });
  });

  test('a response after the budget is spent starts no further attempt', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const sleeps = jest.spyOn(globalThis, 'setTimeout');
    mockFetch.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS);
      jest.advanceTimersByTime(USAGE_ENQUEUE_RETRY_BUDGET_MS);
      return new Response(null, { status: 503 });
    });
    expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'unavailable',
      reason: 'http_503',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expectUnavailableWarning('http_503', true);
  });

  test('clips sleep to the remaining budget and sends nothing after exhaustion', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const sleeps = jest.spyOn(globalThis, 'setTimeout');
    mockFetch.mockImplementation(async () => {
      jest.advanceTimersByTime(39_900);
      return new Response(null, { status: 503 });
    });
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'unavailable', reason: 'http_503' });
    expect(sleeps.mock.calls.map(([, delay]) => delay)).toEqual([100]);
    expect(performance.now()).toBe(40_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      'usage enqueue unavailable',
      expect.objectContaining({ duplicate_possible: true })
    );
  });

  test('a stalled runtime exhausts the budget without masking the last network failure', async () => {
    jest.useFakeTimers();
    mockFetch.mockImplementation(async () => {
      jest.advanceTimersByTime(40_000);
      throw new Error('synthetic network failure');
    });
    const result = await enqueueUsage(payload, { retryTransientFailures: true });
    expect(result).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expectUnavailableWarning('request_failed', true);
  });

  test.each([false, true])(
    'Vercel transport bypasses CF policy (retries=%s)',
    async retryTransientFailures => {
      const vercel = jest.fn(async (_payload: UsageRecordRequest) => ({
        kind: 'accepted' as const,
      }));
      jest.doMock('@kilocode/usage-queue/vercel/config', () => ({
        USAGE_VERCEL_QUEUE_ENABLED: true,
      }));
      jest.doMock('@kilocode/usage-queue/vercel/publisher', () => ({ enqueueVercelUsage: vercel }));
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      let selected = enqueueUsage;
      try {
        jest.isolateModules(() => {
          selected =
            jest.requireActual<typeof UsagePublisherModule>('./usage-publisher').enqueueUsage;
        });
        expect(await selected(payload, { retryTransientFailures })).toEqual({ kind: 'accepted' });
        expect(vercel).toHaveBeenCalledTimes(1);
        expect(vercel).toHaveBeenCalledWith(payload);
        expect(mockFetch).not.toHaveBeenCalled();
        expect(timeout).not.toHaveBeenCalled();
      } finally {
        jest.dontMock('@kilocode/usage-queue/vercel/config');
        jest.dontMock('@kilocode/usage-queue/vercel/publisher');
      }
    }
  );
});

describe('publisher attempt diagnostics', () => {
  /** Its stable hash falls in the 1% fast-acceptance sample; `payload.core.id` does not. */
  const sampledUsageId = '29ccd244-ea35-4e96-98bc-ea9436a9db98';
  const sampledPayload = {
    ...payload,
    core: { ...payload.core, id: sampledUsageId },
    metadata: { ...payload.metadata, id: sampledUsageId },
  } satisfies LlmUsageQueueMessage;

  function attemptRows(): Record<string, unknown>[] {
    return info.mock.calls.flatMap(([line]) => {
      if (typeof line !== 'string') return [];
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' &&
        parsed !== null &&
        'event' in parsed &&
        parsed.event === 'usage_publisher_attempt'
        ? [parsed as Record<string, unknown>]
        : [];
    });
  }

  /** Real `AbortSignal.timeout` timers ignore Jest's clock, so drive them from fake timers. */
  function useFakeClock() {
    jest.useFakeTimers();
    return jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
  }

  /** A fetch whose headers arrive, or whose transport fails, after `ms` unless its signal aborts first. */
  function settleAfter(ms: number, settle: () => Response | Error) {
    return (_url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          const result = settle();
          if (result instanceof Error) reject(result);
          else resolve(result);
        }, ms);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('synthetic abort'));
          },
          { once: true }
        );
      });
  }

  /** A lost request: only its abort signal ends the attempt. */
  function neverRespond(_url: Parameters<typeof fetch>[0], init?: RequestInit) {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('synthetic abort')), {
        once: true,
      });
    });
  }

  test('a fast first acceptance is logged only for usage IDs in the stable 1% sample', async () => {
    useFakeClock();
    mockFetch.mockImplementation(settleAfter(120, () => new Response(null, { status: 202 })));

    const unsampled = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.advanceTimersByTimeAsync(120);
    expect(await unsampled).toEqual({ kind: 'accepted' });
    expect(attemptRows()).toEqual([]);

    const sampled = enqueueUsage(sampledPayload, { retryTransientFailures: true });
    await jest.advanceTimersByTimeAsync(120);
    expect(await sampled).toEqual({ kind: 'accepted' });
    expect(attemptRows()).toEqual([
      {
        event: 'usage_publisher_attempt',
        sample_rate: 0.01,
        usage_id: sampledUsageId,
        execution_region: 'unknown',
        attempt: 1,
        max_attempts: USAGE_ENQUEUE_MAX_ATTEMPTS,
        accepted: true,
        attempt_end: 'response_headers',
        http_status: 202,
        duration_ms: 120,
        timeout_ms: USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS,
        remaining_budget_ms: USAGE_ENQUEUE_RETRY_BUDGET_MS,
        start_offset_ms: 0,
      },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    [999, false],
    [1_000, true],
    [15_000, true],
  ])('a %i ms first acceptance outside the sample is logged: %s', async (ms, logged) => {
    process.env.VERCEL_REGION = 'sfo1';
    useFakeClock();
    mockFetch.mockImplementation(settleAfter(ms, () => new Response(null, { status: 202 })));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.advanceTimersByTimeAsync(ms);
    expect(await result).toEqual({ kind: 'accepted' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(attemptRows()).toEqual(
      logged
        ? [
            expect.objectContaining({
              sample_rate: 1,
              usage_id: payload.core.id,
              execution_region: 'sfo1',
              attempt: 1,
              accepted: true,
              http_status: 202,
              duration_ms: ms,
            }),
          ]
        : []
    );
  });

  test('logs every attempt of a retried publication with its own clocks and actual backoff', async () => {
    const timeouts = useFakeClock();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    mockFetch
      .mockImplementationOnce(neverRespond)
      .mockImplementationOnce(
        settleAfter(300, () => new Response('sensitive upstream body', { status: 503 }))
      )
      .mockImplementationOnce(
        settleAfter(50, () => new Error('synthetic-publisher-secret sensitive network error'))
      )
      .mockImplementationOnce(settleAfter(10, () => new Response(null, { status: 202 })));

    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });

    const common = {
      event: 'usage_publisher_attempt',
      sample_rate: 1,
      usage_id: payload.core.id,
      execution_region: 'unknown',
      max_attempts: USAGE_ENQUEUE_MAX_ATTEMPTS,
    };
    // Backoff is full jitter at 0.5: 250, 500 and 1,000 ms before attempts two to four.
    expect(attemptRows()).toEqual([
      {
        ...common,
        attempt: 1,
        accepted: false,
        attempt_end: 'timeout',
        reason: 'timeout',
        duration_ms: USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS,
        timeout_ms: USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS,
        remaining_budget_ms: USAGE_ENQUEUE_RETRY_BUDGET_MS,
        start_offset_ms: 0,
      },
      {
        ...common,
        attempt: 2,
        accepted: false,
        attempt_end: 'response_headers',
        http_status: 503,
        reason: 'http_503',
        duration_ms: 300,
        timeout_ms: USAGE_ENQUEUE_RETRY_TIMEOUT_MS,
        remaining_budget_ms: 19_750,
        start_offset_ms: 20_250,
        prior_backoff_planned_ms: 250,
        prior_backoff_elapsed_ms: 250,
      },
      {
        ...common,
        attempt: 3,
        accepted: false,
        attempt_end: 'network_error',
        reason: 'request_failed',
        duration_ms: 50,
        timeout_ms: USAGE_ENQUEUE_RETRY_TIMEOUT_MS,
        remaining_budget_ms: 18_950,
        start_offset_ms: 21_050,
        prior_backoff_planned_ms: 500,
        prior_backoff_elapsed_ms: 500,
      },
      {
        ...common,
        attempt: 4,
        accepted: true,
        attempt_end: 'response_headers',
        http_status: 202,
        duration_ms: 10,
        timeout_ms: USAGE_ENQUEUE_RETRY_TIMEOUT_MS,
        remaining_budget_ms: 17_900,
        start_offset_ms: 22_100,
        prior_backoff_planned_ms: 1_000,
        prior_backoff_elapsed_ms: 1_000,
      },
    ]);

    // The existing policy, request bytes and retry warnings are unchanged.
    expect(timeouts.mock.calls).toEqual([
      [USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
      [USAGE_ENQUEUE_RETRY_TIMEOUT_MS],
    ]);
    expect(mockFetch.mock.calls.map(([, init]) => init?.body)).toEqual(
      Array(USAGE_ENQUEUE_MAX_ATTEMPTS).fill(JSON.stringify(payload))
    );
    expect(warn.mock.calls.map(([message, fields]) => [message, fields])).toEqual(
      ['timeout', 'http_503', 'request_failed'].map((reason, index) => [
        'usage enqueue retrying',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          reason,
          attempt: index + 1,
          duplicate_possible: true,
        },
      ])
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/secret|sensitive|Bearer|https?:/);
  });

  test('reports the clipped timeout and remaining budget after a runtime stall', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const timeouts = jest.spyOn(AbortSignal, 'timeout');
    mockFetch
      .mockImplementationOnce(async () => {
        jest.advanceTimersByTime(38_000);
        return new Response(null, { status: 503 });
      })
      .mockResolvedValue(new Response(null, { status: 202 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });
    expect(timeouts.mock.calls).toEqual([[USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS], [1_750]]);
    expect(attemptRows()).toEqual([
      expect.objectContaining({
        attempt: 1,
        http_status: 503,
        duration_ms: 38_000,
        timeout_ms: USAGE_ENQUEUE_FIRST_ATTEMPT_TIMEOUT_MS,
        remaining_budget_ms: USAGE_ENQUEUE_RETRY_BUDGET_MS,
        start_offset_ms: 0,
      }),
      expect.objectContaining({
        attempt: 2,
        accepted: true,
        duration_ms: 0,
        timeout_ms: 1_750,
        remaining_budget_ms: 1_750,
        start_offset_ms: 38_250,
        prior_backoff_planned_ms: 250,
        prior_backoff_elapsed_ms: 250,
      }),
    ]);
  });

  test('a single-attempt call reports its two-second window and no retry budget', async () => {
    mockFetch.mockResolvedValue(new Response('sensitive body', { status: 401 }));
    expect(await enqueueUsage(payload)).toEqual({ kind: 'unavailable', reason: 'http_401' });
    const [row] = attemptRows();
    expect(row).toEqual(
      expect.objectContaining({
        attempt: 1,
        max_attempts: 1,
        accepted: false,
        attempt_end: 'response_headers',
        http_status: 401,
        reason: 'http_401',
        timeout_ms: USAGE_ENQUEUE_TIMEOUT_MS,
        start_offset_ms: expect.any(Number),
      })
    );
    expect(row).not.toHaveProperty('remaining_budget_ms');
    expect(row).not.toHaveProperty('prior_backoff_elapsed_ms');
    expectUnavailableWarning('http_401');
  });

  test('a timed-out or failed transport never reports an HTTP status', async () => {
    useFakeClock();
    mockFetch
      .mockImplementationOnce(neverRespond)
      .mockImplementationOnce(settleAfter(5, () => new Error('synthetic network failure')));
    const timedOut = enqueueUsage(payload);
    await jest.runAllTimersAsync();
    expect(await timedOut).toEqual({ kind: 'unavailable', reason: 'timeout' });
    const failed = enqueueUsage(payload);
    await jest.runAllTimersAsync();
    expect(await failed).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    const rows = attemptRows();
    expect(rows.map(row => [row.attempt_end, row.reason, row.duration_ms])).toEqual([
      ['timeout', 'timeout', USAGE_ENQUEUE_TIMEOUT_MS],
      ['network_error', 'request_failed', 5],
    ]);
    for (const row of rows) expect(row).not.toHaveProperty('http_status');
  });

  test('a confirmed 202 is returned without waiting for an unfinished response body', async () => {
    const body = new ReadableStream({
      pull: () => new Promise<void>(() => {}),
      cancel: () => new Promise<void>(() => {}),
    });
    mockFetch.mockResolvedValue(new Response(body, { status: 202 }));
    expect(await enqueueUsage(sampledPayload, { retryTransientFailures: true })).toEqual({
      kind: 'accepted',
    });
    expect(attemptRows()).toEqual([
      expect.objectContaining({ usage_id: sampledUsageId, accepted: true, http_status: 202 }),
    ]);
  });

  test('an Enkrypt publication labels its attempts with the usage kind and write ID', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const usageWrite = {
      id: 'a8f2c3d4-5e6f-4a1b-9c2d-3e4f5a6b7c8d',
      occurredAt: '2026-08-05T10:11:12.945Z',
      organizationId: 'b9e1f2a3-4b5c-4d6e-8f7a-1b2c3d4e5f6a',
      kiloUserId: 'oauth/synthetic',
      sessionId: null,
      apiKind: 'messages',
      decision: 'blocked',
      creditsCost: 7,
      addedLatencyMs: 12,
    } satisfies EnkryptUsageWriteInput;
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const result = enqueueEnkryptUsage(usageWrite);
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://usage.example.test/enkrypt-usage',
      'https://usage.example.test/enkrypt-usage',
    ]);
    expect(
      attemptRows().map(({ usage_id, usage_kind, attempt, http_status }) => ({
        usage_id,
        usage_kind,
        attempt,
        http_status,
      }))
    ).toEqual([
      { usage_id: usageWrite.id, usage_kind: 'enkrypt_usage', attempt: 1, http_status: 503 },
      { usage_id: usageWrite.id, usage_kind: 'enkrypt_usage', attempt: 2, http_status: 202 },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'usage enqueue retrying',
      expect.objectContaining({ usageId: usageWrite.id, usage_kind: 'enkrypt_usage' })
    );
  });

  test('a throwing logger changes neither retry classification nor confirmed acceptance', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const loggerFailure = new Error('synthetic logger failure');
    info.mockImplementation(() => {
      throw loggerFailure;
    });
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.runAllTimersAsync();
    expect(await result).toEqual({ kind: 'accepted' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls).toEqual([
      [
        'usage enqueue retrying',
        {
          usageId: payload.core.id,
          execution_region: 'unknown',
          reason: 'http_503',
          attempt: 1,
          duplicate_possible: true,
        },
      ],
    ]);
    // Both attempt lines were attempted; each failure is reported and publication continues.
    expect(info).toHaveBeenCalledTimes(2);
    expect(jest.mocked(captureException).mock.calls).toEqual([
      [loggerFailure, { level: 'warning', tags: { source: 'usage_publisher_attempt_log' } }],
      [loggerFailure, { level: 'warning', tags: { source: 'usage_publisher_attempt_log' } }],
    ]);
  });

  test('a throwing logger on a terminal failure keeps the terminal outcome', async () => {
    info.mockImplementation(() => {
      throw new Error('synthetic logger failure');
    });
    mockFetch.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'unavailable',
      reason: 'http_401',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expectUnavailableWarning('http_401');
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
