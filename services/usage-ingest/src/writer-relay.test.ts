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

it.each([200, 307, 429, 503, 'throws'])(
  'correlates relay timing without changing response/transport outcome (%s)',
  async status => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const clock = vi.spyOn(performance, 'now').mockReturnValue(20);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const failure = new Error('sensitive-transport-error');
    const response = typeof status === 'number' ? new Response(null, { status }) : undefined;
    const fetch = vi.fn().mockImplementation(async () => {
      clock.mockReturnValue(67);
      if (!response) throw failure;
      return response;
    });
    vi.stubGlobal('fetch', fetch);
    const work = relay.fetch(
      new Request(target, {
        method: 'POST',
        headers: {
          'x-usage-id': usage.core.id,
          'x-internal-api-key': 'sensitive-writer',
          'x-vercel-protection-bypass': 'sensitive-bypass',
          cookie: 'sensitive-cookie',
        },
        body: JSON.stringify(usage),
      }),
      { ...relayEnv, USAGE_INGEST_DIAGNOSTICS: 'all' }
    );
    if (response) expect(await work).toBe(response);
    else await expect(work).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(target);
    expect(fetch.mock.calls[0][1].headers.get('x-usage-id')).toBe(usage.core.id);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        level: 'info',
        event: 'usage_ingest_relay_forward',
        usage_id: usage.core.id,
        relay_entry_at_ms: 1000,
        before_forward_at_ms: 1000,
        after_forward_at_ms: 1000,
        forward_duration_ms: 47,
        outcome: response ? 'response' : 'request_failed',
        ...(response ? { writer_status: status } : {}),
      })
    );
    for (const value of [
      'sensitive-',
      usage.metadata.user_prompt_prefix,
      usage.core.kilo_user_id,
      target,
    ]) {
      expect(JSON.stringify(info.mock.calls)).not.toContain(value);
    }
  }
);

it.each([undefined, 'not-a-uuid', 'private@example.test', 'x'.repeat(1000)])(
  'does not forward or log an invalid correlation marker (%s)',
  async marker => {
    const fetch = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', fetch);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await relay.fetch(
      new Request(target, {
        method: 'POST',
        headers: {
          'x-internal-api-key': 'synthetic-key',
          ...(marker ? { 'x-usage-id': marker } : {}),
        },
      }),
      { ...relayEnv, USAGE_INGEST_DIAGNOSTICS: 'all' }
    );
    expect(fetch.mock.calls[0][1].headers.has('x-usage-id')).toBe(false);
    expect(info).not.toHaveBeenCalled();
  }
);

it('leaves relay correlation off by default and ignores log sink failures when enabled', async () => {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response()));
  vi.stubGlobal('fetch', fetch);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {
    throw new Error('sink');
  });
  const request = () =>
    new Request(target, {
      method: 'POST',
      headers: {
        'x-internal-api-key': 'synthetic-key',
        'x-usage-id': usage.core.id,
      },
    });
  expect((await relay.fetch(request(), relayEnv)).status).toBe(200);
  expect(info).not.toHaveBeenCalled();
  expect(fetch.mock.calls[0][1].headers.has('x-usage-id')).toBe(false);
  expect(
    (await relay.fetch(request(), { ...relayEnv, USAGE_INGEST_DIAGNOSTICS: 'all' })).status
  ).toBe(200);
  expect(fetch).toHaveBeenCalledTimes(2);
});
