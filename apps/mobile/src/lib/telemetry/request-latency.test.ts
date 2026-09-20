/* oxlint-disable max-lines -- one latency suite; splitting the buffer and fetch cases would duplicate the scheduler/collector scaffold */
import { describe, expect, it, vi } from 'vitest';

import {
  createLatencyBuffer,
  createLatencyFetch,
  FLUSH_INTERVAL_MS,
  LATENCY_REQUEST_ID_HEADER,
  type LatencyBatch,
  type LatencyBuffer,
  type LatencySample,
  MAX_BATCH_SAMPLES,
  MAX_PAYLOAD_BYTES,
  trpcProceduresFromUrl,
} from '@/lib/telemetry/request-latency';

function sample(overrides: Partial<LatencySample> = {}): LatencySample {
  return {
    requestId: 'req-1',
    procedures: ['user.getMe'],
    ttfbMs: 1,
    totalMs: 2,
    status: 200,
    ok: true,
    ...overrides,
  };
}

function createCollector(): { batches: LatencyBatch[]; send: (batch: LatencyBatch) => void } {
  const batches: LatencyBatch[] = [];
  return {
    batches,
    send: (batch: LatencyBatch) => {
      batches.push(batch);
    },
  };
}

type ManualScheduler = {
  schedule: (callback: () => void, delayMs: number) => () => void;
  fire: () => void;
  pendingCount: () => number;
};

function createManualScheduler(): ManualScheduler {
  const pending: { callback: () => void; delayMs: number }[] = [];
  return {
    schedule: (callback, delayMs) => {
      const entry = { callback, delayMs };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index !== -1) {
          pending.splice(index, 1);
        }
      };
    },
    fire: () => {
      const entries = pending.splice(0);
      for (const entry of entries) {
        entry.callback();
      }
    },
    pendingCount: () => pending.length,
  };
}

function sequenceNow(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value ?? values.at(-1) ?? 0;
  };
}

function capturingFetch(response: Response): { base: typeof fetch; headers: Headers[] } {
  const headers: Headers[] = [];
  const mock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return response;
  });
  return { base: mock as unknown as typeof fetch, headers };
}

function createRecordingBuffer(): { buffer: LatencyBuffer; recorded: LatencySample[] } {
  const recorded: LatencySample[] = [];
  return {
    buffer: {
      record: (item: LatencySample) => {
        recorded.push(item);
      },
      flush: () => {
        // The fetch tests read `recorded` directly.
      },
    },
    recorded,
  };
}

/** The fetch wrapper records a sample once the cloned body read settles, so a
 *  test that reads `recorded`/`batches` drains the pending microtasks first. */
async function settleMeasurement(): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, 0);
  });
}

async function recordStatus(status: number): Promise<LatencySample | undefined> {
  const collector = createCollector();
  const buffer = createLatencyBuffer({
    send: collector.send,
    now: () => 0,
    schedule: createManualScheduler().schedule,
  });
  const { base } = capturingFetch(new Response('body', { status }));
  const wrapped = createLatencyFetch(base, buffer, { now: () => 0, newId: () => 'id' });

  await wrapped('https://api.kilo.ai/api/trpc/user.getMe');
  await settleMeasurement();
  buffer.flush();

  return collector.batches[0]?.samples[0];
}

describe('trpcProceduresFromUrl', () => {
  it('returns an empty list for a non-trpc URL', () => {
    expect(trpcProceduresFromUrl('https://api.kilo.ai/health')).toEqual([]);
    expect(trpcProceduresFromUrl('https://api.kilo.ai/api/other/user.getMe')).toEqual([]);
  });

  it('splits a batched procedure list and strips the query string', () => {
    expect(
      trpcProceduresFromUrl(
        'https://api.kilo.ai/api/trpc/user.getMe,activeSessions.list,cliSessionsV2.getSessionMessagesPage?batch=1&input=secret'
      )
    ).toEqual(['user.getMe', 'activeSessions.list', 'cliSessionsV2.getSessionMessagesPage']);
  });

  it('returns an empty list for the bare trpc path', () => {
    expect(trpcProceduresFromUrl('https://api.kilo.ai/api/trpc/')).toEqual([]);
  });
});

describe('createLatencyBuffer', () => {
  it('sends nothing when flushed empty', () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });

    buffer.flush();

    expect(collector.batches).toHaveLength(0);
  });

  it('flushes a batch at the sample cap', () => {
    const collector = createCollector();
    const scheduler = createManualScheduler();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: scheduler.schedule,
    });

    for (let index = 0; index < MAX_BATCH_SAMPLES; index += 1) {
      buffer.record(sample({ requestId: `req-${index}` }));
    }

    expect(collector.batches).toHaveLength(1);
    expect(collector.batches[0]?.samples).toHaveLength(MAX_BATCH_SAMPLES);
    expect(collector.batches[0]?.samples.at(-1)?.requestId).toBe(`req-${MAX_BATCH_SAMPLES - 1}`);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('flushes on the scheduled interval after the first pending sample', () => {
    const collector = createCollector();
    const scheduler = createManualScheduler();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: scheduler.schedule,
    });

    buffer.record(sample());
    expect(collector.batches).toHaveLength(0);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.fire();

    expect(collector.batches).toHaveLength(1);
    expect(collector.batches[0]?.samples).toHaveLength(1);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('flushes when the injected clock passes the interval', () => {
    const collector = createCollector();
    const scheduler = createManualScheduler();
    let clock = 0;
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => clock,
      schedule: scheduler.schedule,
    });

    buffer.record(sample({ requestId: 'first' }));
    clock = FLUSH_INTERVAL_MS;
    buffer.record(sample({ requestId: 'second' }));

    expect(collector.batches).toHaveLength(1);
    expect(collector.batches[0]?.samples.map(item => item.requestId)).toEqual(['first', 'second']);
  });

  it('drops the oldest samples when the serialized batch exceeds the payload cap', () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });
    const huge = (prefix: string) => sample({ requestId: `${prefix}${'x'.repeat(24_000)}` });

    buffer.record(huge('oldest-'));
    buffer.record(huge('middle-'));
    buffer.record(huge('newest-'));
    buffer.flush();

    const sent = collector.batches[0];
    expect(sent?.samples).toHaveLength(2);
    expect(sent?.samples[0]?.requestId.startsWith('middle-')).toBe(true);
    expect(sent?.samples[1]?.requestId.startsWith('newest-')).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(sent)).byteLength).toBeLessThanOrEqual(
      MAX_PAYLOAD_BYTES
    );
  });

  it('drops a single sample larger than the payload cap', () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });

    buffer.record(sample({ requestId: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) }));
    buffer.flush();

    expect(collector.batches).toHaveLength(0);
  });

  it('does not propagate a throwing send at the cap or on flush', () => {
    const buffer = createLatencyBuffer({
      send: () => {
        throw new Error('ingest down');
      },
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });

    expect(() => {
      for (let index = 0; index < MAX_BATCH_SAMPLES; index += 1) {
        buffer.record(sample());
      }
      buffer.record(sample());
      buffer.flush();
    }).not.toThrow();
  });

  it('swallows an async send rejection', async () => {
    let calls = 0;
    const buffer = createLatencyBuffer({
      send: async () => {
        calls += 1;
        await Promise.reject(new Error('ingest down'));
      },
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });

    buffer.record(sample());
    buffer.flush();
    await Promise.resolve();

    expect(calls).toBe(1);
  });
});

describe('createLatencyFetch', () => {
  it('sets one request id per call and preserves the caller headers', async () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });
    const ids = ['id-1', 'id-2'];
    let nextId = 0;
    const nextRequestId = () => {
      const id = ids[nextId];
      nextId += 1;
      return id ?? 'fallback';
    };
    const { base, headers } = capturingFetch(new Response('ok', { status: 200 }));
    const wrapped = createLatencyFetch(base, buffer, {
      now: () => 0,
      newId: nextRequestId,
    });

    await wrapped('https://api.kilo.ai/api/trpc/user.getMe', {
      headers: { authorization: 'Bearer token', [LATENCY_REQUEST_ID_HEADER]: 'stale' },
    });
    await wrapped('https://api.kilo.ai/api/trpc/user.getMe', {
      headers: { authorization: 'Bearer token' },
    });

    expect(headers[0]?.get(LATENCY_REQUEST_ID_HEADER)).toBe('id-1');
    expect(headers[0]?.get('authorization')).toBe('Bearer token');
    expect(headers[1]?.get(LATENCY_REQUEST_ID_HEADER)).toBe('id-2');
    expect(nextId).toBe(2);
  });

  it('records exact ttfb and total from the injected clock', async () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });
    const { base } = capturingFetch(new Response('body', { status: 200 }));
    const wrapped = createLatencyFetch(base, buffer, {
      now: sequenceNow([100, 150, 200]),
      newId: () => 'id',
    });

    await wrapped('https://api.kilo.ai/api/trpc/user.getMe');
    await settleMeasurement();
    buffer.flush();

    expect(collector.batches[0]?.samples[0]).toMatchObject({ ttfbMs: 50, totalMs: 100 });
  });

  it('falls back to ttfb when the clone body read fails', async () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });
    const response = new Response('body', { status: 200 });
    vi.spyOn(response, 'clone').mockImplementation(() => {
      throw new Error('body already consumed');
    });
    const { base } = capturingFetch(response);
    const wrapped = createLatencyFetch(base, buffer, {
      now: sequenceNow([10, 30, 999]),
      newId: () => 'id',
    });

    await wrapped('https://api.kilo.ai/api/trpc/user.getMe');
    await settleMeasurement();
    buffer.flush();

    expect(collector.batches[0]?.samples[0]).toMatchObject({ ttfbMs: 20, totalMs: 20 });
  });

  it('records the three procedures of a batched URL', async () => {
    const collector = createCollector();
    const buffer = createLatencyBuffer({
      send: collector.send,
      now: () => 0,
      schedule: createManualScheduler().schedule,
    });
    const { base } = capturingFetch(new Response('body', { status: 200 }));
    const wrapped = createLatencyFetch(base, buffer, { now: () => 0, newId: () => 'id' });

    await wrapped(
      'https://api.kilo.ai/api/trpc/user.getMe,activeSessions.list,cliSessionsV2.getSessionMessagesPage?batch=1'
    );
    await settleMeasurement();
    buffer.flush();

    expect(collector.batches[0]?.samples[0]?.procedures).toEqual([
      'user.getMe',
      'activeSessions.list',
      'cliSessionsV2.getSessionMessagesPage',
    ]);
  });

  it('returns the response before the cloned body read settles', async () => {
    const { buffer, recorded } = createRecordingBuffer();
    const gate: { release?: () => void } = {};
    const readGate = new Promise<void>(resolve => {
      gate.release = resolve;
    });
    const response = new Response('{"result":1}', { status: 200 });
    // The clone's body read stays pending until this test releases it, so a
    // wrapper that awaited the measurement would never return the response.
    vi.spyOn(response, 'clone').mockReturnValue({
      text: async () => {
        await readGate;
        return '{"result":1}';
      },
    } as unknown as Response);
    const { base } = capturingFetch(response);
    const wrapped = createLatencyFetch(base, buffer, { now: () => 0, newId: () => 'id' });

    let delivered = false;
    const pending = (async () => {
      const result = await wrapped('https://api.kilo.ai/api/trpc/user.getMe');
      delivered = true;
      return result;
    })();
    await settleMeasurement();

    // The caller holds the response while the body read is still pending, and
    // no sample has been recorded yet.
    expect(delivered).toBe(true);
    expect(recorded).toHaveLength(0);

    gate.release?.();
    const result = await pending;
    await expect(result.text()).resolves.toBe('{"result":1}');
    await settleMeasurement();

    expect(result).toBe(response);
    expect(recorded).toHaveLength(1);
  });

  it('records status and ok for success, batch, and failure responses', async () => {
    expect(await recordStatus(200)).toMatchObject({ status: 200, ok: true });
    expect(await recordStatus(207)).toMatchObject({ status: 207, ok: true });
    expect(await recordStatus(404)).toMatchObject({ status: 404, ok: false });
    expect(await recordStatus(500)).toMatchObject({ status: 500, ok: false });
  });

  it('re-throws a fetch rejection unchanged and records nothing', async () => {
    const original = new Error('socket closed');
    const { buffer, recorded } = createRecordingBuffer();
    const base = vi.fn().mockRejectedValue(original) as unknown as typeof fetch;
    const wrapped = createLatencyFetch(base, buffer, { now: () => 0, newId: () => 'id' });

    await expect(wrapped('https://api.kilo.ai/api/trpc/user.getMe')).rejects.toBe(original);

    expect(recorded).toHaveLength(0);
  });

  it('does not record a non-trpc URL but returns the response unchanged', async () => {
    const response = new Response('ok', { status: 200 });
    const { buffer, recorded } = createRecordingBuffer();
    const { base } = capturingFetch(response);
    const wrapped = createLatencyFetch(base, buffer, { now: () => 0, newId: () => 'id' });

    const result = await wrapped('https://api.kilo.ai/health');

    expect(result).toBe(response);
    expect(recorded).toHaveLength(0);
  });
});
