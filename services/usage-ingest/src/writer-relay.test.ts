import { afterEach, expect, it, vi } from 'vitest';
import { USAGE_WRITER_TIMEOUT_MS } from '@kilocode/worker-utils/usage-writer-client';
import worker from './index';
import relay from './writer-relay';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';

const target = 'https://staging-app.kilo.ai/api/internal/usage/record';
const relayEnv = { USAGE_WRITER_URL: target } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  ['https://relay.invalid/other', 'POST', 404],
  ['https://relay.invalid/api/internal/usage/record', 'GET', 405],
  ['https://relay.invalid/api/internal/usage/record', 'POST', 401],
])('rejects an invalid relay request without egress (%s %s)', async (url, method, status) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const response = await relay.fetch(new Request(url, { method }), relayEnv);
  expect(response.status).toBe(status);
  expect(fetch).not.toHaveBeenCalled();
});

it('uses the fixed target, forwards only writer headers, and does not follow redirects', async () => {
  const response = new Response(null, { status: 307, headers: { location: 'https://other.test' } });
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  const request = new Request('https://caller-selected.test/api/internal/usage/record', {
    method: 'POST',
    headers: {
      'x-internal-api-key': 'synthetic-internal',
      'x-vercel-protection-bypass': 'synthetic-bypass',
      'x-usage-write-source': 'untrusted-source',
      cookie: 'private-cookie',
      authorization: 'unrelated-credential',
    },
    body: JSON.stringify(usage),
  });
  expect(await relay.fetch(request, relayEnv)).toBe(response);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(target, {
    method: 'POST',
    headers: new Headers({
      'content-type': 'application/json',
      'x-internal-api-key': 'synthetic-internal',
      'x-vercel-protection-bypass': 'synthetic-bypass',
      'x-usage-write-source': 'queue',
    }),
    body: request.body,
    redirect: 'manual',
    signal: expect.any(AbortSignal),
  });
});

it.each(['recorded', 'duplicate', 401, 429, 503, 'wrong-id', 'throws'])(
  'keeps queue acknowledgement/retry semantics through the relay (%s)',
  async outcome => {
    const fetch = vi.fn().mockImplementation(async () => {
      if (outcome === 'throws') throw new Error('synthetic transport failure');
      if (typeof outcome === 'number') return new Response(null, { status: outcome });
      return Response.json({
        status: outcome === 'wrong-id' ? 'recorded' : outcome,
        result: {
          usageId: outcome === 'wrong-id' ? crypto.randomUUID() : usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: 1234,
        },
      });
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const binding = {
      fetch: vi.fn<Fetcher['fetch']>(function (this: unknown, input, init) {
        expect(this).toBe(binding);
        return relay.fetch(new Request(input, init), relayEnv);
      }),
      connect: vi.fn<Fetcher['connect']>(() => {
        throw new Error('Unexpected TCP connection');
      }),
    };
    const env = {
      USAGE_INGEST_MODE: 'processing',
      USAGE_WRITER_URL: target,
      USAGE_WRITER_SECRET: 'synthetic-writer',
      USAGE_WRITER_RELAY: binding,
      USAGE_INGEST_QUEUE: {} as Env['USAGE_INGEST_QUEUE'],
      USAGE_INGEST_DLQ: {} as Env['USAGE_INGEST_DLQ'],
    } satisfies Env;
    const message = {
      id: 'queue-relay-test',
      timestamp: new Date(),
      attempts: 1,
      body: usage,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const batch = {
      queue: 'usage',
      messages: [message],
      ackAll: vi.fn(),
      retryAll: vi.fn(),
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    };
    const processing = worker.queue(batch, env);
    if (outcome === 429 || outcome === 503) {
      await expect(processing).rejects.toThrow('Usage writer overloaded');
    } else await processing;
    expect(binding.fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalledTimes(
      outcome === 'recorded' || outcome === 'duplicate' ? 1 : 0
    );
    expect(message.retry).toHaveBeenCalledTimes(
      outcome === 'recorded' || outcome === 'duplicate' ? 0 : 1
    );
  }
);

it('propagates caller cancellation to the outbound writer request', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  await relay.fetch(
    new Request(target, {
      method: 'POST',
      headers: { 'x-internal-api-key': 'synthetic-secret' },
      signal: controller.signal,
    }),
    relayEnv
  );
  const signal = fetch.mock.calls[0][1]?.signal;
  expect(signal?.aborted).toBe(false);
  controller.abort();
  expect(signal?.aborted).toBe(true);
  expect(timeout).toHaveBeenCalledExactlyOnceWith(USAGE_WRITER_TIMEOUT_MS);
});
