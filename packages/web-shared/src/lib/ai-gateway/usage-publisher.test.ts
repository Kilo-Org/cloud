jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USAGE_INGEST_URL: 'https://usage.example.test/usage',
  USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publisher-secret',
}));

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createServer } from 'node:http';
import {
  enqueueUsage,
  USAGE_ENQUEUE_TIMEOUT_MS,
  USAGE_ENQUEUE_MAX_ATTEMPTS,
} from './usage-publisher';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';

const payload: UsageRecordRequest = {
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
    market_cost: null,
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
let warn: jest.SpiedFunction<typeof console.warn>;

beforeEach(() => {
  config.USAGE_INGEST_URL = 'https://usage.example.test/usage';
  config.USAGE_INGEST_PUBLISH_SECRET = 'synthetic-publisher-secret';
  mockFetch.mockReset();
  jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function expectUnavailableWarning(reason: string) {
  expect(warn.mock.calls).toEqual([
    ['usage enqueue unavailable', { usageId: payload.core.id, kind: 'unavailable', reason }],
  ]);
  const logged = JSON.stringify(warn.mock.calls);
  expect(logged).not.toContain(config.USAGE_INGEST_URL);
  expect(logged).not.toContain(config.USAGE_INGEST_PUBLISH_SECRET);
  expect(logged).not.toMatch(/Bearer|sensitive|prompt|metadata/);
}

describe('enqueueUsage', () => {
  test('preserves the complete payload and ID with dedicated publisher authentication', async () => {
    const event = {
      ...payload,
      bouncer_usage_event: { request_id: 'synthetic-request', payload: { cost: 1234 } },
    } satisfies UsageRecordRequest;
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
    'is disabled without %s and makes no network call',
    async key => {
      config[key] = '';
      expect(await enqueueUsage(payload)).toEqual({ kind: 'disabled' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test('contains a malformed configured URL through the request failure path', async () => {
    config.USAGE_INGEST_URL = 'malformed-sensitive-url';
    expect(await enqueueUsage(payload)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    expect(mockFetch).not.toHaveBeenCalled();
    expectUnavailableWarning('request_failed');
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
      expectUnavailableWarning(outcome.reason);
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
      expectUnavailableWarning('timeout');
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
    expectUnavailableWarning('request_failed');
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
      expect(timeouts.mock.calls).toEqual([[USAGE_ENQUEUE_TIMEOUT_MS], [USAGE_ENQUEUE_TIMEOUT_MS]]);
      expect(warn.mock.calls).toEqual([
        [
          'usage enqueue retrying',
          {
            usageId: payload.core.id,
            reason: failure === 'network' ? 'request_failed' : `http_${failure}`,
            attempt: 1,
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
      config[key] = '';
      expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
        kind: 'disabled',
      });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    }
  );

  test('does not retry a malformed URL', async () => {
    config.USAGE_INGEST_URL = 'sensitive-malformed-url';
    expect(await enqueueUsage(payload, { retryTransientFailures: true })).toEqual({
      kind: 'unavailable',
      reason: 'request_failed',
    });
    expect(mockFetch).not.toHaveBeenCalled();
    expectUnavailableWarning('request_failed');
  });

  test('waits for each backoff boundary before issuing the next fetch', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    mockFetch.mockResolvedValue(new Response(null, { status: 503 }));
    const result = enqueueUsage(payload, { retryTransientFailures: true });
    await jest.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(199);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(399);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(mockFetch).toHaveBeenCalledTimes(3);
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
    jest.spyOn(Math, 'random').mockReturnValue(0);
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
    expect(delays.mock.calls.map(([, delay]) => delay)).toEqual([200, 400]);
    expect(warn.mock.calls).toEqual([
      [
        'usage enqueue retrying',
        { usageId: payload.core.id, reason: 'request_failed', attempt: 1 },
      ],
      [
        'usage enqueue retrying',
        { usageId: payload.core.id, reason: 'request_failed', attempt: 2 },
      ],
      [
        'usage enqueue unavailable',
        { usageId: payload.core.id, kind: 'unavailable', reason: 'request_failed' },
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
      kind: 'unavailable',
      reason: 'http_401',
    });
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
          reason: failure === 'timeout' ? 'timeout' : 'request_failed',
          attempt: 1,
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        );
      }
    }
  );

  test('exhausts three real HTTP timeouts within the bounded attempt/backoff budget', async () => {
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
      expect(elapsed).toBeGreaterThanOrEqual(USAGE_ENQUEUE_TIMEOUT_MS * USAGE_ENQUEUE_MAX_ATTEMPTS);
      expect(elapsed).toBeLessThan(USAGE_ENQUEUE_TIMEOUT_MS * USAGE_ENQUEUE_MAX_ATTEMPTS + 2_000);
      expect(requests).toBe(USAGE_ENQUEUE_MAX_ATTEMPTS);
      expect(mockFetch).toHaveBeenCalledTimes(USAGE_ENQUEUE_MAX_ATTEMPTS);
      expect(
        warn.mock.calls.filter(([message]) => message === 'usage enqueue retrying')
      ).toHaveLength(2);
      expect(warn).toHaveBeenLastCalledWith('usage enqueue unavailable', {
        usageId: payload.core.id,
        kind: 'unavailable',
        reason: 'timeout',
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  }, 10_000);
});
