import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFetch, MAX_USAGE_BYTES, type Env } from './publish-usage';
import { usage } from './usage.test-fixture';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('production ingress timing', () => {
  it.each([
    { duration: 10, fail: false },
    { duration: 999.5, fail: false },
    { duration: 1000, fail: false },
    { duration: 10, fail: true },
  ])('reports every send with full boundaries: $duration $fail', async ({ duration, fail }) => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(10 + duration);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = fail
      ? vi.fn().mockRejectedValue(new Error('secret'))
      : vi.fn().mockResolvedValue(undefined);
    const env = {
      USAGE_INGEST_PUBLISH_SECRET: 'secret',
      USAGE_INGEST_QUEUE: { send },
    } as unknown as Env;
    const response = await handleFetch(
      new Request('https://test.invalid/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify(usage),
      }),
      env
    );
    expect(response.status).toBe(fail ? 503 : 202);
    expect(send).toHaveBeenCalledTimes(1);
    const calls = [...info.mock.calls, ...warn.mock.calls];
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0][0]))).toEqual({
      level: 'info',
      event: 'usage_ingest_enqueue_start',
      usage_id: usage.core.id,
      publisher_entry_at_ms: expect.any(Number),
      before_send_at_ms: expect.any(Number),
    });
    expect(JSON.parse(String(calls[1][0]))).toEqual({
      level: fail ? 'warn' : 'info',
      event: 'usage_ingest_enqueue',
      usage_id: usage.core.id,
      outcome: fail ? 'unavailable' : 'accepted',
      ...(fail
        ? {}
        : {
            publisher_entry_at_ms: expect.any(Number),
            before_send_at_ms: expect.any(Number),
          }),
      after_send_at_ms: expect.any(Number),
      send_duration_ms: Math.round(duration),
      ...(fail ? { error_name: 'Error' } : {}),
    });
  });

  it.each([
    { name: 'missing authorization', status: 401, authorization: undefined, body: '{}' },
    { name: 'invalid JSON', status: 400, authorization: 'Bearer secret', body: '{' },
    {
      name: 'oversized body',
      status: 413,
      authorization: 'Bearer secret',
      body: 'x'.repeat(MAX_USAGE_BYTES + 1),
    },
  ])(
    'rejects $name before emitting enqueue diagnostics',
    async ({ status, authorization, body }) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const send = vi.fn().mockResolvedValue(undefined);
      const env = {
        USAGE_INGEST_PUBLISH_SECRET: 'secret',
        USAGE_INGEST_QUEUE: { send },
      } as unknown as Env;
      const response = await handleFetch(
        new Request('https://test.invalid/usage', {
          method: 'POST',
          headers: authorization ? { authorization } : undefined,
          body,
        }),
        env
      );
      expect(response.status).toBe(status);
      expect(send).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      if (status === 400) {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            level: 'warn',
            event: 'usage_ingest_rejected',
            category: 'malformed_json',
          })
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    }
  );

  it.each([false, true])('isolates a throwing log sink when failure is %s', async fail => {
    vi.spyOn(console, fail ? 'warn' : 'info').mockImplementation(() => {
      throw new Error('sink');
    });
    const send = fail
      ? vi.fn().mockRejectedValue(new Error('queue'))
      : vi.fn().mockResolvedValue(undefined);
    const env = {
      USAGE_INGEST_PUBLISH_SECRET: 'secret',
      USAGE_INGEST_QUEUE: { send },
    } as unknown as Env;
    const response = await handleFetch(
      new Request('https://test.invalid/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify(usage),
      }),
      env
    );
    expect(response.status).toBe(fail ? 503 : 202);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

const writerUrl = 'https://writer.example.test/api/internal/usage/record';
const writerResult = {
  usageId: usage.core.id,
  createdAt: usage.core.created_at,
  newMicrodollarsUsed: 1234,
};

type WriterCase =
  | 'recorded'
  | 'duplicate'
  | 'admission_429'
  | 'http_503'
  | 'timeout'
  | 'not_recorded'
  | 'wrong_id';

function writer(behaviour: WriterCase): typeof fetch {
  return vi.fn<typeof fetch>(async (_url, init) => {
    switch (behaviour) {
      case 'recorded':
        return Response.json({ status: 'recorded', result: writerResult });
      case 'duplicate':
        return Response.json({
          status: 'duplicate',
          result: { ...writerResult, newMicrodollarsUsed: null },
        });
      case 'admission_429':
        return Response.json(
          { error: 'Usage writer overloaded', reason: 'queue_limit' },
          { status: 429 }
        );
      case 'http_503':
        return new Response('synthetic unavailable', { status: 503 });
      case 'not_recorded':
        return Response.json({ status: 'not_recorded', result: null });
      case 'wrong_id':
        return Response.json({
          status: 'recorded',
          result: { ...writerResult, usageId: '00000000-0000-4000-8000-000000000000' },
        });
      case 'timeout':
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) throw new Error('Expected abort signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
    }
  });
}

function limiter(success = true) {
  return { limit: vi.fn(async (_options: RateLimitOptions) => ({ success })) };
}

function directEnv(
  mode: string | undefined,
  send: ReturnType<typeof vi.fn>,
  overrides: Partial<Env> = {}
): Env {
  return {
    USAGE_INGEST_PUBLISH_SECRET: 'secret',
    USAGE_INGEST_QUEUE: { send },
    USAGE_INGEST_DIRECT_MODE: mode,
    USAGE_INGEST_DIRECT_TIMEOUT_MS: '20',
    USAGE_INGEST_STALL_HEDGE_MS: '5',
    USAGE_DIRECT_LIMITER: limiter(),
    USAGE_WRITER_URL: writerUrl,
    USAGE_WRITER_SECRET: 'synthetic-writer-secret',
    ...overrides,
  } as unknown as Env;
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((promise: Promise<unknown>) => {
      pending.push(promise);
    }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

function publishRequest(init: { authorization?: string; body?: string } = {}) {
  return new Request('https://test.invalid/usage', {
    method: 'POST',
    headers: { authorization: init.authorization ?? 'Bearer secret' },
    body: init.body ?? JSON.stringify(usage),
  });
}

function structuredLogs() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  // Structured events are JSON objects; the shared writer client also logs plain-text
  // messages, which are skipped. A malformed JSON line fails the test.
  return () =>
    [...info.mock.calls, ...warn.mock.calls].flatMap(([line]) =>
      typeof line === 'string' && line.startsWith('{')
        ? [JSON.parse(line) as Record<string, unknown>]
        : []
    );
}

function events(logs: Record<string, unknown>[], event: string) {
  return logs.filter(record => record.event === event);
}

function heldSend() {
  const settle = Promise.withResolvers<undefined>();
  return { settle, send: vi.fn(() => settle.promise) };
}

// Release a held send only once the direct attempt has settled, so timer jitter
// cannot let the queue win a race the test means the direct lane to lose first.
async function afterDirectSettles(settled: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(settled()).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 0));
}

const writerReportedUnavailable = () =>
  vi.mocked(console.warn).mock.calls.some(([line]) => line === 'usage writer unavailable');

const directFailures: { writer: WriterCase; outcome: string; status?: number }[] = [
  { writer: 'admission_429', outcome: 'http_error', status: 429 },
  { writer: 'http_503', outcome: 'http_error', status: 503 },
  { writer: 'timeout', outcome: 'timeout' },
  { writer: 'not_recorded', outcome: 'not_recorded' },
  { writer: 'wrong_id', outcome: 'invalid_response' },
];

describe('direct lane off', () => {
  it.each([undefined, 'off', '', 'FIRST', 'on-stall', 'true'])(
    'treats mode %s as off: no limiter, no writer, no publish event',
    async mode => {
      const logs = structuredLogs();
      const fetchWriter = writer('recorded');
      vi.stubGlobal('fetch', fetchWriter);
      const send = vi.fn().mockResolvedValue(undefined);
      const env = directEnv(mode, send);
      const response = await handleFetch(publishRequest(), env);
      expect(response.status).toBe(202);
      expect(send).toHaveBeenCalledTimes(1);
      expect(fetchWriter).not.toHaveBeenCalled();
      expect(env.USAGE_DIRECT_LIMITER?.limit).not.toHaveBeenCalled();
      expect(logs().map(record => record.event)).toEqual([
        'usage_ingest_enqueue_start',
        'usage_ingest_enqueue',
      ]);
    }
  );
});

describe('direct lane first', () => {
  it.each(['recorded', 'duplicate'] as const)(
    'answers 202 on a matching %s without touching the queue',
    async outcome => {
      const logs = structuredLogs();
      const fetchWriter = writer(outcome);
      vi.stubGlobal('fetch', fetchWriter);
      const send = vi.fn().mockResolvedValue(undefined);
      const env = directEnv('first', send);
      const response = await handleFetch(publishRequest(), env);
      expect(response.status).toBe(202);
      expect(send).not.toHaveBeenCalled();
      expect(env.USAGE_DIRECT_LIMITER?.limit).toHaveBeenCalledExactlyOnceWith({
        key: 'ingress_direct',
      });
      expect(fetchWriter).toHaveBeenCalledTimes(1);
      const [url, init] = vi.mocked(fetchWriter).mock.calls[0] ?? [];
      expect(url).toBe(writerUrl);
      expect(init?.headers).toMatchObject({
        'x-internal-api-key': 'synthetic-writer-secret',
        'x-usage-write-source': 'ingress_direct',
      });
      expect(init?.body).toBe(JSON.stringify(usage));
      expect(events(logs(), 'usage_ingest_enqueue_start')).toHaveLength(0);
      expect(events(logs(), 'usage_ingest_publish')).toEqual([
        {
          level: 'info',
          event: 'usage_ingest_publish',
          mode: 'first',
          lane: 'direct',
          status: 202,
          usage_id: usage.core.id,
          rate_limited: false,
          direct_outcome: outcome,
          direct_duration_ms: expect.any(Number),
        },
      ]);
    }
  );

  it.each(directFailures)(
    'falls through to the queue on $writer without retrying the writer',
    async ({ writer: behaviour, outcome, status }) => {
      const logs = structuredLogs();
      const fetchWriter = writer(behaviour);
      vi.stubGlobal('fetch', fetchWriter);
      const send = vi.fn().mockResolvedValue(undefined);
      const response = await handleFetch(publishRequest(), directEnv('first', send));
      expect(response.status).toBe(202);
      expect(fetchWriter).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledExactlyOnceWith(usage, { contentType: 'json' });
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'accepted' }]);
      expect(events(logs(), 'usage_ingest_publish')).toEqual([
        {
          level: 'info',
          event: 'usage_ingest_publish',
          mode: 'first',
          lane: 'queue',
          status: 202,
          usage_id: usage.core.id,
          rate_limited: false,
          direct_outcome: outcome,
          direct_duration_ms: expect.any(Number),
          ...(status === undefined ? {} : { direct_status: status }),
          ...(behaviour === 'admission_429' ? { direct_admission_reason: 'queue_limit' } : {}),
          send_duration_ms: expect.any(Number),
        },
      ]);
    }
  );

  it.each([
    { name: 'over the limit', limiterValue: limiter(false), outcome: 'rate_limited' },
    { name: 'a missing binding', limiterValue: undefined, outcome: 'limiter_unavailable' },
    {
      name: 'a throwing limiter',
      limiterValue: {
        limit: vi.fn(async () => {
          throw new Error('synthetic limiter failure');
        }),
      },
      outcome: 'limiter_unavailable',
    },
  ])('skips the writer and queues with $name', async ({ name, limiterValue, outcome }) => {
    const logs = structuredLogs();
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await handleFetch(
      publishRequest(),
      directEnv('first', send, { USAGE_DIRECT_LIMITER: limiterValue as RateLimit | undefined })
    );
    expect(response.status).toBe(202);
    expect(fetchWriter).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(events(logs(), 'usage_ingest_publish')).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_publish',
        mode: 'first',
        lane: 'queue',
        status: 202,
        usage_id: usage.core.id,
        rate_limited: true,
        direct_outcome: outcome,
        send_duration_ms: expect.any(Number),
      },
    ]);
    expect(events(logs(), 'usage_ingest_direct_limiter_failed')).toEqual(
      name === 'a throwing limiter'
        ? [
            {
              level: 'warn',
              event: 'usage_ingest_direct_limiter_failed',
              usage_id: usage.core.id,
              error_name: 'Error',
            },
          ]
        : []
    );
  });

  it('logs and queues when the writer client throws instead of returning an outcome', async () => {
    const logs = structuredLogs();
    vi.spyOn(console, 'info').mockImplementation(line => {
      if (line === 'usage writer acknowledged') throw new TypeError('synthetic sink failure');
    });
    vi.spyOn(console, 'warn').mockImplementation(line => {
      if (line === 'usage writer unavailable') throw new TypeError('synthetic sink failure');
    });
    vi.stubGlobal('fetch', writer('recorded'));
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await handleFetch(publishRequest(), directEnv('first', send));
    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(events(logs(), 'usage_ingest_direct_failed')).toEqual([
      {
        level: 'warn',
        event: 'usage_ingest_direct_failed',
        usage_id: usage.core.id,
        error_name: 'TypeError',
      },
    ]);
  });

  it('queues with missing writer configuration without network I/O', async () => {
    const logs = structuredLogs();
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await handleFetch(
      publishRequest(),
      directEnv('first', send, { USAGE_WRITER_SECRET: undefined })
    );
    expect(response.status).toBe(202);
    expect(fetchWriter).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      { lane: 'queue', direct_outcome: 'missing_config', rate_limited: false },
    ]);
  });

  it.each(['throw', 'reject'] as const)(
    'keeps the queue 503 when the fallback send fails with %s',
    async failure => {
      const logs = structuredLogs();
      vi.stubGlobal('fetch', writer('http_503'));
      const send =
        failure === 'throw'
          ? vi.fn(() => {
              throw new Error('synthetic sync failure');
            })
          : vi.fn().mockRejectedValue(new Error('synthetic send failure'));
      const response = await handleFetch(publishRequest(), directEnv('first', send));
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'Queue unavailable' });
      expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
        { level: 'warn', mode: 'first', lane: 'queue', status: 503, direct_outcome: 'http_error' },
      ]);
    }
  );
});

describe('direct lane on_stall', () => {
  it('answers from the queue without a direct attempt when the send beats the hedge', async () => {
    const logs = structuredLogs();
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const send = vi.fn().mockResolvedValue(undefined);
    const env = directEnv('on_stall', send, { USAGE_INGEST_STALL_HEDGE_MS: '1000' });
    const startedAt = performance.now();
    const response = await handleFetch(publishRequest(), env);
    expect(response.status).toBe(202);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(fetchWriter).not.toHaveBeenCalled();
    expect(env.USAGE_DIRECT_LIMITER?.limit).not.toHaveBeenCalled();
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'accepted' }]);
    expect(events(logs(), 'usage_ingest_publish')).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_publish',
        mode: 'on_stall',
        lane: 'queue',
        status: 202,
        usage_id: usage.core.id,
        rate_limited: false,
        send_duration_ms: expect.any(Number),
      },
    ]);
  });

  it.each(['throw', 'reject'] as const)(
    'returns 503 without a direct attempt when the send fails before the hedge (%s)',
    async failure => {
      const logs = structuredLogs();
      const fetchWriter = writer('recorded');
      vi.stubGlobal('fetch', fetchWriter);
      const send =
        failure === 'throw'
          ? vi.fn(() => {
              throw new Error('synthetic sync failure');
            })
          : vi.fn().mockRejectedValue(new Error('synthetic send failure'));
      const response = await handleFetch(
        publishRequest(),
        directEnv('on_stall', send, { USAGE_INGEST_STALL_HEDGE_MS: '1000' })
      );
      expect(response.status).toBe(503);
      expect(fetchWriter).not.toHaveBeenCalled();
      expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
        { level: 'warn', mode: 'on_stall', lane: 'queue', status: 503, rate_limited: false },
      ]);
      expect(events(logs(), 'usage_ingest_publish')[0]).not.toHaveProperty('direct_outcome');
    }
  );

  it.each(['accept', 'reject'] as const)(
    'answers 202 from a direct hedge and logs one queue completion when the parked send later %ss',
    async late => {
      const logs = structuredLogs();
      const fetchWriter = writer('duplicate');
      vi.stubGlobal('fetch', fetchWriter);
      const stalled = Promise.withResolvers<undefined>();
      const send = vi.fn(() => stalled.promise);
      const { ctx, pending } = executionContext();
      const response = await handleFetch(publishRequest(), directEnv('on_stall', send), ctx);
      expect(response.status).toBe(202);
      expect(send).toHaveBeenCalledTimes(1);
      expect(fetchWriter).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetchWriter).mock.calls[0]?.[1]?.body).toBe(JSON.stringify(usage));
      expect(vi.mocked(ctx.waitUntil)).toHaveBeenCalledTimes(2);
      expect(events(logs(), 'usage_ingest_enqueue')).toHaveLength(0);
      expect(events(logs(), 'usage_ingest_publish')).toEqual([
        {
          level: 'info',
          event: 'usage_ingest_publish',
          mode: 'on_stall',
          lane: 'direct',
          status: 202,
          usage_id: usage.core.id,
          rate_limited: false,
          direct_outcome: 'duplicate',
          direct_duration_ms: expect.any(Number),
        },
      ]);
      if (late === 'accept') stalled.resolve(undefined);
      else stalled.reject(new Error('synthetic late send failure'));
      await Promise.all(pending);
      const outcome = late === 'accept' ? 'accepted' : 'unavailable';
      expect(events(logs(), 'usage_ingest_enqueue_start')).toHaveLength(1);
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([
        { usage_id: usage.core.id, outcome },
      ]);
      expect(events(logs(), 'usage_ingest_enqueue_observed')).toMatchObject([
        { usage_id: usage.core.id, outcome },
      ]);
      expect(events(logs(), 'usage_ingest_publish')).toHaveLength(1);
      expect(fetchWriter).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it('handles a late send rejection after a direct 202 even without an ExecutionContext', async () => {
    const logs = structuredLogs();
    vi.stubGlobal('fetch', writer('recorded'));
    const stalled = Promise.withResolvers<undefined>();
    const response = await handleFetch(
      publishRequest(),
      directEnv(
        'on_stall',
        vi.fn(() => stalled.promise)
      )
    );
    expect(response.status).toBe(202);
    stalled.reject(new Error('synthetic late send failure'));
    await vi.waitFor(() =>
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'unavailable' }])
    );
  });

  it.each(directFailures)(
    'awaits the stalled send after a failed $writer hedge',
    async ({ writer: behaviour, outcome, status }) => {
      const logs = structuredLogs();
      const fetchWriter = writer(behaviour);
      vi.stubGlobal('fetch', fetchWriter);
      const { settle, send } = heldSend();
      const work = handleFetch(publishRequest(), directEnv('on_stall', send));
      await afterDirectSettles(writerReportedUnavailable);
      settle.resolve(undefined);
      const response = await work;
      expect(response.status).toBe(202);
      expect(fetchWriter).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'accepted' }]);
      expect(events(logs(), 'usage_ingest_publish')).toEqual([
        {
          level: 'info',
          event: 'usage_ingest_publish',
          mode: 'on_stall',
          lane: 'queue',
          status: 202,
          usage_id: usage.core.id,
          rate_limited: false,
          direct_outcome: outcome,
          direct_duration_ms: expect.any(Number),
          ...(status === undefined ? {} : { direct_status: status }),
          ...(behaviour === 'admission_429' ? { direct_admission_reason: 'queue_limit' } : {}),
          send_duration_ms: expect.any(Number),
        },
      ]);
    }
  );

  it('awaits the stalled send without a writer call when rate limited', async () => {
    const logs = structuredLogs();
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const { settle, send } = heldSend();
    const refusing = limiter(false);
    const work = handleFetch(
      publishRequest(),
      directEnv('on_stall', send, { USAGE_DIRECT_LIMITER: refusing })
    );
    await afterDirectSettles(() => refusing.limit.mock.calls.length > 0);
    settle.resolve(undefined);
    const response = await work;
    expect(response.status).toBe(202);
    expect(fetchWriter).not.toHaveBeenCalled();
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      { lane: 'queue', rate_limited: true, direct_outcome: 'rate_limited' },
    ]);
  });

  it('returns the queue 503 when the hedge fails and the stalled send then rejects', async () => {
    const logs = structuredLogs();
    vi.stubGlobal('fetch', writer('http_503'));
    const { settle, send } = heldSend();
    const work = handleFetch(publishRequest(), directEnv('on_stall', send));
    await afterDirectSettles(writerReportedUnavailable);
    settle.reject(new Error('synthetic send failure'));
    const response = await work;
    expect(response.status).toBe(503);
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      { level: 'warn', lane: 'queue', status: 503, direct_outcome: 'http_error' },
    ]);
  });
});

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([
    promise,
    new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms)),
  ]);
}

function heldWriter() {
  const reply = Promise.withResolvers<Response>();
  const fetchWriter = vi.fn<typeof fetch>(() => reply.promise);
  return { reply, fetchWriter };
}

const recordedReply = () => Response.json({ status: 'recorded', result: writerResult });

describe('direct lane on_stall race after the hedge', () => {
  const longDirectTimeout = { USAGE_INGEST_DIRECT_TIMEOUT_MS: '60000' };

  it('answers the queue 202 without waiting for a direct write still in flight', async () => {
    const logs = structuredLogs();
    const { reply, fetchWriter } = heldWriter();
    vi.stubGlobal('fetch', fetchWriter);
    const stalled = Promise.withResolvers<undefined>();
    const send = vi.fn(() => stalled.promise);
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), directEnv('on_stall', send, longDirectTimeout), ctx);
    await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
    expect(vi.mocked(fetchWriter).mock.calls[0]?.[1]?.body).toBe(JSON.stringify(usage));
    stalled.resolve(undefined);
    const response = await settledWithin(work, 200);
    if (response === 'pending') throw new Error('queue 202 waited for the direct write');
    expect(response.status).toBe(202);
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'accepted' }]);
    expect(events(logs(), 'usage_ingest_publish')).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_publish',
        mode: 'on_stall',
        lane: 'queue',
        status: 202,
        usage_id: usage.core.id,
        rate_limited: false,
        direct_pending: true,
        send_duration_ms: expect.any(Number),
      },
    ]);
    expect(events(logs(), 'usage_ingest_direct_observed')).toHaveLength(0);

    reply.resolve(recordedReply());
    await Promise.all(pending);
    expect(events(logs(), 'usage_ingest_direct_observed')).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_direct_observed',
        usage_id: usage.core.id,
        rate_limited: false,
        direct_outcome: 'recorded',
        direct_duration_ms: expect.any(Number),
      },
    ]);
    expect(events(logs(), 'usage_ingest_publish')).toHaveLength(1);
    expect(events(logs(), 'usage_ingest_enqueue')).toHaveLength(1);
    expect(events(logs(), 'usage_ingest_enqueue_observed')).toMatchObject([
      { outcome: 'accepted' },
    ]);
    expect(fetchWriter).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting for the direct write after the send fails and answers 202 when it records', async () => {
    const logs = structuredLogs();
    const { reply, fetchWriter } = heldWriter();
    vi.stubGlobal('fetch', fetchWriter);
    const stalled = Promise.withResolvers<undefined>();
    const { ctx, pending } = executionContext();
    const work = handleFetch(
      publishRequest(),
      directEnv(
        'on_stall',
        vi.fn(() => stalled.promise),
        longDirectTimeout
      ),
      ctx
    );
    await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
    stalled.reject(new Error('synthetic send failure'));
    expect(await settledWithin(work, 50)).toBe('pending');
    reply.resolve(recordedReply());
    const response = await work;
    expect(response.status).toBe(202);
    await Promise.all(pending);
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      { mode: 'on_stall', lane: 'direct', status: 202, direct_outcome: 'recorded' },
    ]);
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'unavailable' }]);
    expect(events(logs(), 'usage_ingest_enqueue_observed')).toMatchObject([
      { outcome: 'unavailable' },
    ]);
    expect(events(logs(), 'usage_ingest_direct_observed')).toHaveLength(0);
  });

  it('returns the queue 503 when the send fails and the pending direct write then fails', async () => {
    const logs = structuredLogs();
    const { reply, fetchWriter } = heldWriter();
    vi.stubGlobal('fetch', fetchWriter);
    const stalled = Promise.withResolvers<undefined>();
    const work = handleFetch(
      publishRequest(),
      directEnv(
        'on_stall',
        vi.fn(() => stalled.promise),
        longDirectTimeout
      )
    );
    await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
    stalled.reject(new Error('synthetic send failure'));
    expect(await settledWithin(work, 50)).toBe('pending');
    reply.resolve(new Response('synthetic unavailable', { status: 503 }));
    const response = await work;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Queue unavailable' });
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'unavailable' }]);
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      {
        level: 'warn',
        lane: 'queue',
        status: 503,
        direct_outcome: 'http_error',
        direct_status: 503,
      },
    ]);
  });

  it('handles a direct write that fails after the queue 202 without a context', async () => {
    const logs = structuredLogs();
    const { reply, fetchWriter } = heldWriter();
    vi.stubGlobal('fetch', fetchWriter);
    const stalled = Promise.withResolvers<undefined>();
    const work = handleFetch(
      publishRequest(),
      directEnv(
        'on_stall',
        vi.fn(() => stalled.promise),
        longDirectTimeout
      )
    );
    await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
    stalled.resolve(undefined);
    expect((await work).status).toBe(202);
    reply.reject(new Error('synthetic late writer failure'));
    await vi.waitFor(() =>
      expect(events(logs(), 'usage_ingest_direct_observed')).toMatchObject([
        { direct_outcome: 'request_failed' },
      ])
    );
  });

  it.each(['queue first', 'direct first'] as const)(
    'keeps the 202 when ctx.waitUntil throws (%s)',
    async order => {
      const logs = structuredLogs();
      const { reply, fetchWriter } = heldWriter();
      vi.stubGlobal('fetch', fetchWriter);
      const stalled = Promise.withResolvers<undefined>();
      const ctx = {
        waitUntil: vi.fn(() => {
          throw new Error('synthetic waitUntil failure');
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;
      const work = handleFetch(
        publishRequest(),
        directEnv(
          'on_stall',
          vi.fn(() => stalled.promise),
          longDirectTimeout
        ),
        ctx
      );
      await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
      if (order === 'queue first') stalled.resolve(undefined);
      else reply.resolve(recordedReply());
      expect((await work).status).toBe(202);
      if (order === 'queue first') reply.resolve(recordedReply());
      else stalled.resolve(undefined);
      await vi.waitFor(() =>
        expect(events(logs(), 'usage_ingest_background_unregistered')).toHaveLength(1)
      );
      expect(events(logs(), 'usage_ingest_enqueue_observation_unregistered')).toHaveLength(1);
      expect(events(logs(), 'usage_ingest_publish')).toHaveLength(1);
    }
  );

  it('keeps the queue 202 and the parked direct write when every log sink throws', async () => {
    for (const level of ['info', 'warn'] as const) {
      vi.spyOn(console, level).mockImplementation(() => {
        throw new Error('synthetic sink failure');
      });
    }
    const { reply, fetchWriter } = heldWriter();
    vi.stubGlobal('fetch', fetchWriter);
    const stalled = Promise.withResolvers<undefined>();
    const send = vi.fn(() => stalled.promise);
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), directEnv('on_stall', send, longDirectTimeout), ctx);
    await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
    stalled.resolve(undefined);
    expect((await work).status).toBe(202);
    reply.resolve(recordedReply());
    await Promise.all(pending);
    expect(fetchWriter).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('treats a direct answer it cannot log as unconfirmed and waits for the send', async () => {
    // The shared writer client logs its acknowledgement inside its own try block, so a
    // throwing sink turns `recorded` into a failure; the queue then decides the response.
    for (const level of ['info', 'warn'] as const) {
      vi.spyOn(console, level).mockImplementation(() => {
        throw new Error('synthetic sink failure');
      });
    }
    const { reply, fetchWriter } = heldWriter();
    vi.stubGlobal('fetch', fetchWriter);
    const stalled = Promise.withResolvers<undefined>();
    const send = vi.fn(() => stalled.promise);
    const work = handleFetch(publishRequest(), directEnv('on_stall', send, longDirectTimeout));
    await vi.waitFor(() => expect(fetchWriter).toHaveBeenCalledTimes(1));
    reply.resolve(recordedReply());
    expect(await settledWithin(work, 50)).toBe('pending');
    stalled.resolve(undefined);
    expect((await work).status).toBe(202);
    expect(fetchWriter).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clears the hedge timer when the send answers first', async () => {
    structuredLogs();
    vi.stubGlobal('fetch', writer('recorded'));
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const response = await handleFetch(
      publishRequest(),
      directEnv('on_stall', vi.fn().mockResolvedValue(undefined), {
        USAGE_INGEST_STALL_HEDGE_MS: '1000',
      })
    );
    expect(response.status).toBe(202);
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalledExactlyOnceWith(setTimer.mock.results[0]?.value);
  });
});

describe('direct lane request gate', () => {
  it.each(['first', 'on_stall'])(
    'rejects auth, JSON and size failures in %s before either lane',
    async mode => {
      const logs = structuredLogs();
      const fetchWriter = writer('recorded');
      vi.stubGlobal('fetch', fetchWriter);
      for (const [request, status] of [
        [publishRequest({ authorization: 'Bearer wrong' }), 401],
        [publishRequest({ body: '{' }), 400],
        [publishRequest({ body: 'x'.repeat(MAX_USAGE_BYTES + 1) }), 413],
        [
          publishRequest({
            body: JSON.stringify({ ...usage, core: { ...usage.core, cost: 1.5 } }),
          }),
          400,
        ],
      ] as const) {
        const send = vi.fn().mockResolvedValue(undefined);
        const env = directEnv(mode, send);
        expect((await handleFetch(request, env)).status).toBe(status);
        expect(send).not.toHaveBeenCalled();
        expect(env.USAGE_DIRECT_LIMITER?.limit).not.toHaveBeenCalled();
      }
      expect(fetchWriter).not.toHaveBeenCalled();
      expect(events(logs(), 'usage_ingest_publish')).toHaveLength(0);
    }
  );

  it.each(['first', 'on_stall'])('fails closed with no publish secret in %s', async mode => {
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const send = vi.fn().mockResolvedValue(undefined);
    const response = await handleFetch(
      publishRequest(),
      directEnv(mode, send, { USAGE_INGEST_PUBLISH_SECRET: undefined })
    );
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
    expect(fetchWriter).not.toHaveBeenCalled();
  });

  it.each(['0', '-5', '1.5', 'abc', ''])(
    'uses the 2000 ms default direct timeout for invalid value %j',
    async value => {
      structuredLogs();
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      vi.stubGlobal('fetch', writer('recorded'));
      await handleFetch(
        publishRequest(),
        directEnv('first', vi.fn(), { USAGE_INGEST_DIRECT_TIMEOUT_MS: value })
      );
      expect(timeout).toHaveBeenCalledTimes(1);
      const writerTimeout = timeout.mock.calls[0]?.[0] ?? 0;
      expect(writerTimeout).toBeGreaterThan(1900);
      expect(writerTimeout).toBeLessThanOrEqual(2000);
    }
  );
});

describe('direct lane limiter deadline', () => {
  const stalledLimiter = () => ({
    limit: vi.fn((_options: RateLimitOptions) => new Promise<RateLimitOutcome>(() => {})),
  });

  it('queues after the direct deadline in first when the limiter never answers', async () => {
    const logs = structuredLogs();
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const send = vi.fn().mockResolvedValue(undefined);
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const response = await handleFetch(
      publishRequest(),
      directEnv('first', send, { USAGE_DIRECT_LIMITER: stalledLimiter() as unknown as RateLimit })
    );
    expect(response.status).toBe(202);
    expect(fetchWriter).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(clearTimer).toHaveBeenCalled();
    expect(events(logs(), 'usage_ingest_direct_limiter_failed')).toEqual([
      {
        level: 'warn',
        event: 'usage_ingest_direct_limiter_failed',
        usage_id: usage.core.id,
        error_name: 'TimeoutError',
      },
    ]);
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      { mode: 'first', lane: 'queue', direct_outcome: 'limiter_unavailable', rate_limited: true },
    ]);
  });

  it('returns 503 in on_stall when the send fails and the limiter never answers', async () => {
    const logs = structuredLogs();
    const fetchWriter = writer('recorded');
    vi.stubGlobal('fetch', fetchWriter);
    const { settle, send } = heldSend();
    const limiter = stalledLimiter();
    const work = handleFetch(
      publishRequest(),
      directEnv('on_stall', send, { USAGE_DIRECT_LIMITER: limiter as unknown as RateLimit })
    );
    await vi.waitFor(() => expect(limiter.limit).toHaveBeenCalledTimes(1));
    settle.reject(new Error('synthetic send failure'));
    const response = await work;
    expect(response.status).toBe(503);
    expect(fetchWriter).not.toHaveBeenCalled();
    expect(events(logs(), 'usage_ingest_direct_limiter_failed')).toMatchObject([
      { error_name: 'TimeoutError' },
    ]);
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([
      { outcome: 'unavailable', error_name: 'Error' },
    ]);
    expect(events(logs(), 'usage_ingest_publish')).toMatchObject([
      { mode: 'on_stall', lane: 'queue', status: 503, direct_outcome: 'limiter_unavailable' },
    ]);
  });

  it('gives the writer only the time the limiter left of the direct deadline', async () => {
    structuredLogs();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', writer('recorded'));
    const slowLimiter = {
      limit: vi.fn(
        () =>
          new Promise<RateLimitOutcome>(resolve => setTimeout(() => resolve({ success: true }), 30))
      ),
    };
    const response = await handleFetch(
      publishRequest(),
      directEnv('first', vi.fn(), {
        USAGE_INGEST_DIRECT_TIMEOUT_MS: '200',
        USAGE_DIRECT_LIMITER: slowLimiter as unknown as RateLimit,
      })
    );
    expect(response.status).toBe(202);
    const writerTimeout = timeout.mock.calls[0]?.[0] ?? 0;
    expect(writerTimeout).toBeLessThanOrEqual(175);
    expect(writerTimeout).toBeGreaterThan(0);
  });
});

describe('queue failure diagnostics', () => {
  it.each(['throw', 'reject'] as const)(
    'logs the send error name, not its message, when the send fails with %s in off',
    async failure => {
      const logs = structuredLogs();
      const send =
        failure === 'throw'
          ? vi.fn(() => {
              throw new TypeError('sensitive send failure');
            })
          : vi.fn().mockRejectedValue(new TypeError('sensitive send failure'));
      const response = await handleFetch(publishRequest(), directEnv('off', send));
      expect(response.status).toBe(503);
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([
        { outcome: 'unavailable', error_name: 'TypeError' },
      ]);
      expect(JSON.stringify(logs())).not.toContain('sensitive send failure');
    }
  );
});
