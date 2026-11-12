import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HEDGE_DELAY_MS,
  handleFetch,
  hedgeDelayMs,
  hedgeEligible,
  hedgePercent,
  MAX_USAGE_BYTES,
  type Env,
} from './publish-usage';
import { usage } from './usage.test-fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type SendFn = (...args: unknown[]) => Promise<unknown>;

function usageWithLastDigit(digit: string) {
  const id = `${usage.core.id.slice(0, -1)}${digit}`;
  return { ...usage, core: { ...usage.core, id }, metadata: { ...usage.metadata, id } };
}

function publishRequest(
  init: { authorization?: string; body?: string; event?: typeof usage } = {}
): Request {
  return new Request('https://test.invalid/usage', {
    method: 'POST',
    headers: { authorization: init.authorization ?? 'Bearer secret' },
    body: init.body ?? JSON.stringify(init.event ?? usage),
  });
}

function hedgeEnv(
  main: SendFn,
  hedge: SendFn | undefined,
  vars: Partial<Record<'mode' | 'delay' | 'percent', string>> = { mode: 'on' }
): Env {
  return {
    USAGE_INGEST_PUBLISH_SECRET: 'secret',
    USAGE_INGEST_QUEUE: { send: main },
    ...(hedge ? { USAGE_INGEST_HEDGE_QUEUE: { send: hedge } } : {}),
    ...(vars.mode === undefined ? {} : { USAGE_INGEST_HEDGE_MODE: vars.mode }),
    ...(vars.delay === undefined ? {} : { USAGE_INGEST_HEDGE_DELAY_MS: vars.delay }),
    ...(vars.percent === undefined ? {} : { USAGE_INGEST_HEDGE_PERCENT: vars.percent }),
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

function structuredLogs() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () =>
    [...info.mock.calls, ...warn.mock.calls].map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>
    );
}

function events(logs: Record<string, unknown>[], event: string) {
  return logs.filter(record => record.event === event);
}

function heldSend() {
  const settle = Promise.withResolvers<undefined>();
  return { settle, send: vi.fn<SendFn>(() => settle.promise) };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
}

async function state<T>(promise: Promise<T>): Promise<T | 'pending'> {
  let result: T | 'pending' = 'pending';
  void promise.then(value => {
    result = value;
  });
  await flush();
  return result;
}

async function untilHedgeDue(delayMs = DEFAULT_HEDGE_DELAY_MS): Promise<void> {
  await flush();
  await vi.advanceTimersByTimeAsync(delayMs);
  await flush();
}

describe('hedge configuration parsing', () => {
  it.each([
    [undefined, DEFAULT_HEDGE_DELAY_MS],
    ['', DEFAULT_HEDGE_DELAY_MS],
    ['abc', DEFAULT_HEDGE_DELAY_MS],
    ['-5', DEFAULT_HEDGE_DELAY_MS],
    ['1.5', DEFAULT_HEDGE_DELAY_MS],
    [' 1000', DEFAULT_HEDGE_DELAY_MS],
    ['0', 250],
    ['100', 250],
    ['250', 250],
    ['2500', 2500],
    ['10000', 10_000],
    ['20000', 10_000],
    ['99999999999999999999999', 10_000],
  ])('delay %j resolves to %d ms', (value, expected) => {
    expect(hedgeDelayMs(value)).toBe(expected);
  });

  it.each([
    [undefined, 100],
    ['', 100],
    ['abc', 100],
    ['-1', 100],
    ['50.5', 100],
    ['101', 100],
    ['1000', 100],
    ['0', 0],
    ['50', 50],
    ['100', 100],
  ])('percent %j resolves to %d', (value, expected) => {
    expect(hedgePercent(value)).toBe(expected);
  });

  it('at 50 percent selects only last hex digits 0-7', () => {
    const eligible = [...'0123456789abcdef'].filter(digit => hedgeEligible(`id-${digit}`, 50));
    expect(eligible).toEqual([...'01234567']);
    expect(hedgeEligible('id-A', 50)).toBe(false);
    expect(hedgeEligible('id-F', 100)).toBe(true);
  });

  it('selects nothing at 0 percent and every hex digit at 100 percent', () => {
    for (const digit of '0123456789abcdef') {
      expect(hedgeEligible(`id-${digit}`, 0)).toBe(false);
      expect(hedgeEligible(`id-${digit}`, 100)).toBe(true);
    }
  });

  it.each(['id-g', 'id-z', 'id--', 'id- ', ''])(
    'never selects a usage ID whose last character is not a hex digit (%j)',
    id => {
      expect(hedgeEligible(id, 100)).toBe(false);
    }
  );
});

describe('hedge off or ineligible keeps the single-queue path', () => {
  it.each([
    { name: 'mode missing', vars: {} },
    { name: 'mode off', vars: { mode: 'off' } },
    { name: 'mode ON', vars: { mode: 'ON' } },
    { name: 'mode true', vars: { mode: 'true' } },
    { name: 'percent 0', vars: { mode: 'on', percent: '0' } },
  ])('never calls the hedge queue for a stalled send ($name)', async ({ vars }) => {
    const logs = structuredLogs();
    const main = heldSend();
    const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge, vars), ctx);
    await untilHedgeDue(10_000);
    expect(await state(work)).toBe('pending');
    main.settle.resolve(undefined);
    expect((await work).status).toBe(202);
    await Promise.all(pending);
    expect(hedge).not.toHaveBeenCalled();
    expect(logs().map(log => log.event)).toEqual([
      'usage_ingest_enqueue_start',
      'usage_ingest_enqueue_observed',
      'usage_ingest_enqueue',
    ]);
  });

  it('at 50 percent leaves an ID ending in 8 on the single-queue path and hedges one ending in 7', async () => {
    const logs = structuredLogs();
    const control = heldSend();
    const controlHedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const work = handleFetch(
      publishRequest({ event: usageWithLastDigit('8') }),
      hedgeEnv(control.send, controlHedge, { mode: 'on', percent: '50' }),
      executionContext().ctx
    );
    await untilHedgeDue();
    expect(controlHedge).not.toHaveBeenCalled();
    control.settle.resolve(undefined);
    expect((await work).status).toBe(202);
    expect(events(logs(), 'usage_ingest_hedge')).toEqual([]);

    const treated = heldSend();
    const treatedHedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const treatedResponse = handleFetch(
      publishRequest({ event: usageWithLastDigit('7') }),
      hedgeEnv(treated.send, treatedHedge, { mode: 'on', percent: '50' }),
      executionContext().ctx
    );
    await untilHedgeDue();
    expect(treatedHedge).toHaveBeenCalledTimes(1);
    expect((await treatedResponse).status).toBe(202);
  });

  it.each([
    { name: 'missing authorization', status: 401, authorization: 'Bearer wrong', body: '{}' },
    { name: 'invalid JSON', status: 400, authorization: 'Bearer secret', body: '{' },
    { name: 'invalid schema', status: 400, authorization: 'Bearer secret', body: '{}' },
    {
      name: 'oversized body',
      status: 413,
      authorization: 'Bearer secret',
      body: 'x'.repeat(MAX_USAGE_BYTES + 1),
    },
  ])('rejects $name in on mode before either queue', async ({ status, authorization, body }) => {
    structuredLogs();
    const main = vi.fn<SendFn>().mockResolvedValue(undefined);
    const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const response = await handleFetch(
      publishRequest({ authorization, body }),
      hedgeEnv(main, hedge),
      executionContext().ctx
    );
    expect(response.status).toBe(status);
    expect(main).not.toHaveBeenCalled();
    expect(hedge).not.toHaveBeenCalled();
  });
});

describe('hedge on, main settles before the delay', () => {
  it('answers from a fast main send without a hedge or timer left behind', async () => {
    const logs = structuredLogs();
    const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const response = await handleFetch(
      publishRequest(),
      hedgeEnv(vi.fn<SendFn>().mockResolvedValue(undefined), hedge),
      executionContext().ctx
    );
    expect(response.status).toBe(202);
    expect(hedge).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(events(logs(), 'usage_ingest_hedge')).toEqual([]);
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'accepted' }]);
  });

  it('answers from a slow main send accepted just before the delay', async () => {
    const logs = structuredLogs();
    const main = heldSend();
    const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge), executionContext().ctx);
    await flush();
    await vi.advanceTimersByTimeAsync(999);
    main.settle.resolve(undefined);
    expect((await work).status).toBe(202);
    await vi.advanceTimersByTimeAsync(5000);
    expect(hedge).not.toHaveBeenCalled();
    expect(events(logs(), 'usage_ingest_hedge')).toEqual([]);
  });

  it.each(['reject', 'throw'] as const)(
    'returns 503 without a hedge when the main send fails fast (%s)',
    async failure => {
      const logs = structuredLogs();
      const main =
        failure === 'reject'
          ? vi.fn<SendFn>().mockRejectedValue(new Error('synthetic'))
          : vi.fn<SendFn>(() => {
              throw new Error('synthetic');
            });
      const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
      const response = await handleFetch(
        publishRequest(),
        hedgeEnv(main, hedge),
        executionContext().ctx
      );
      expect(response.status).toBe(503);
      await vi.advanceTimersByTimeAsync(5000);
      expect(hedge).not.toHaveBeenCalled();
      expect(events(logs(), 'usage_ingest_hedge')).toEqual([]);
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'unavailable' }]);
    }
  );

  it('honours a configured delay', async () => {
    structuredLogs();
    const main = heldSend();
    const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const work = handleFetch(
      publishRequest(),
      hedgeEnv(main.send, hedge, { mode: 'on', delay: '2500' }),
      executionContext().ctx
    );
    await flush();
    await vi.advanceTimersByTimeAsync(2499);
    expect(hedge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(hedge).toHaveBeenCalledTimes(1);
    expect((await work).status).toBe(202);
  });
});

describe('hedge on, delay elapses first', () => {
  it.each(['accept', 'reject'] as const)(
    'answers 202 from the hedge and logs the parked main send once when it later %ss',
    async late => {
      const logs = structuredLogs();
      const main = heldSend();
      const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
      const { ctx, pending } = executionContext();
      const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge), ctx);
      await untilHedgeDue();
      expect(hedge).toHaveBeenCalledTimes(1);
      expect(hedge.mock.calls[0]).toEqual(main.send.mock.calls[0]);
      expect(hedge.mock.calls[0]).toEqual([
        expect.objectContaining({ core: expect.objectContaining({ id: usage.core.id }) }),
        { contentType: 'json' },
      ]);
      const response = await state(work);
      if (response === 'pending') throw new Error('hedge acceptance did not answer');
      expect(response.status).toBe(202);
      expect(events(logs(), 'usage_ingest_enqueue')).toEqual([]);
      expect(events(logs(), 'usage_ingest_hedge')).toEqual([]);

      if (late === 'accept') main.settle.resolve(undefined);
      else main.settle.reject(new Error('synthetic late failure'));
      await Promise.all(pending);
      const outcome = late === 'accept' ? 'accepted' : 'unavailable';
      expect(events(logs(), 'usage_ingest_enqueue_start')).toHaveLength(1);
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome }]);
      expect(events(logs(), 'usage_ingest_enqueue_observed')).toMatchObject([{ outcome }]);
      expect(events(logs(), 'usage_ingest_hedge')).toEqual([
        {
          level: 'info',
          event: 'usage_ingest_hedge',
          usage_id: usage.core.id,
          hedge_delay_ms: 1000,
          winner: 'hedge',
          main_outcome: outcome,
          main_send_duration_ms: expect.any(Number),
          ...(late === 'reject' ? { main_error_name: 'Error' } : {}),
          hedge_outcome: 'accepted',
          hedge_send_duration_ms: expect.any(Number),
        },
      ]);
      expect(main.send).toHaveBeenCalledTimes(1);
      expect(hedge).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps waiting after the main send fails and answers 202 when the hedge accepts', async () => {
    const logs = structuredLogs();
    const main = heldSend();
    const hedge = heldSend();
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge.send), ctx);
    await untilHedgeDue();
    main.settle.reject(new Error('synthetic'));
    expect(await state(work)).toBe('pending');
    hedge.settle.resolve(undefined);
    expect((await work).status).toBe(202);
    await Promise.all(pending);
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'unavailable' }]);
    expect(events(logs(), 'usage_ingest_hedge')).toMatchObject([
      { winner: 'hedge', main_outcome: 'unavailable', hedge_outcome: 'accepted' },
    ]);
  });

  it('keeps waiting after the hedge fails and answers 202 when the main send accepts', async () => {
    const logs = structuredLogs();
    const main = heldSend();
    const hedge = vi.fn<SendFn>().mockRejectedValue(new TypeError('synthetic'));
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge), ctx);
    await untilHedgeDue();
    expect(hedge).toHaveBeenCalledTimes(1);
    expect(await state(work)).toBe('pending');
    main.settle.resolve(undefined);
    expect((await work).status).toBe(202);
    await Promise.all(pending);
    expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'accepted' }]);
    expect(events(logs(), 'usage_ingest_hedge')).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_hedge',
        usage_id: usage.core.id,
        hedge_delay_ms: 1000,
        winner: 'main',
        main_outcome: 'accepted',
        main_send_duration_ms: expect.any(Number),
        hedge_outcome: 'unavailable',
        hedge_send_duration_ms: expect.any(Number),
        hedge_error_name: 'TypeError',
      },
    ]);
  });

  it('answers the main acceptance without waiting for a hedge still in flight', async () => {
    const logs = structuredLogs();
    const main = heldSend();
    const hedge = heldSend();
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge.send), ctx);
    await untilHedgeDue();
    main.settle.resolve(undefined);
    const response = await state(work);
    if (response === 'pending') throw new Error('main acceptance waited for the hedge');
    expect(response.status).toBe(202);
    expect(events(logs(), 'usage_ingest_hedge')).toEqual([]);
    hedge.settle.resolve(undefined);
    await Promise.all(pending);
    expect(events(logs(), 'usage_ingest_enqueue')).toHaveLength(1);
    expect(events(logs(), 'usage_ingest_hedge')).toMatchObject([
      { winner: 'main', main_outcome: 'accepted', hedge_outcome: 'accepted' },
    ]);
  });

  it.each(['main first', 'hedge first'] as const)(
    'returns 503 only when both sends fail (%s)',
    async order => {
      const logs = structuredLogs();
      const main = heldSend();
      const hedge = heldSend();
      const { ctx, pending } = executionContext();
      const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge.send), ctx);
      await untilHedgeDue();
      const [first, second] = order === 'main first' ? [main, hedge] : [hedge, main];
      first.settle.reject(new Error('synthetic'));
      expect(await state(work)).toBe('pending');
      second.settle.reject(new Error('synthetic'));
      expect((await work).status).toBe(503);
      await Promise.all(pending);
      expect(events(logs(), 'usage_ingest_enqueue')).toMatchObject([{ outcome: 'unavailable' }]);
      expect(events(logs(), 'usage_ingest_hedge')).toMatchObject([
        {
          level: 'warn',
          winner: 'none',
          main_outcome: 'unavailable',
          hedge_outcome: 'unavailable',
        },
      ]);
    }
  );
});

describe('hedge failures never change the main result', () => {
  const hedgeFailures = [
    {
      name: 'missing hedge binding',
      hedge: undefined,
      ctx: () => executionContext().ctx,
      outcome: 'not_configured',
    },
    {
      name: 'synchronous hedge throw',
      hedge: vi.fn<SendFn>(() => {
        throw new RangeError('synthetic');
      }),
      ctx: () => executionContext().ctx,
      outcome: 'unavailable',
    },
    {
      name: 'waitUntil throws',
      hedge: vi.fn<SendFn>().mockResolvedValue(undefined),
      ctx: () =>
        ({
          waitUntil: vi.fn(() => {
            throw new Error('synthetic waitUntil failure');
          }),
          passThroughOnException: vi.fn(),
        }) as unknown as ExecutionContext,
      outcome: 'unregistered',
    },
    {
      name: 'no execution context',
      hedge: vi.fn<SendFn>().mockResolvedValue(undefined),
      ctx: () => undefined,
      outcome: 'unregistered',
    },
  ];

  for (const failure of hedgeFailures) {
    it.each(['accept', 'reject'] as const)(
      `waits for the main send after a ${failure.name} and keeps its result (%s)`,
      async late => {
        const logs = structuredLogs();
        const main = heldSend();
        const work = handleFetch(
          publishRequest(),
          hedgeEnv(main.send, failure.hedge),
          failure.ctx()
        );
        await untilHedgeDue();
        expect(await state(work)).toBe('pending');
        if (late === 'accept') main.settle.resolve(undefined);
        else main.settle.reject(new Error('synthetic'));
        expect((await work).status).toBe(late === 'accept' ? 202 : 503);
        await flush();
        if (failure.outcome === 'unregistered') expect(failure.hedge).not.toHaveBeenCalled();
        expect(events(logs(), 'usage_ingest_enqueue')).toHaveLength(1);
        expect(events(logs(), 'usage_ingest_hedge')).toMatchObject([
          {
            winner: late === 'accept' ? 'main' : 'none',
            main_outcome: late === 'accept' ? 'accepted' : 'unavailable',
            hedge_outcome: failure.outcome,
          },
        ]);
        failure.hedge?.mockClear();
      }
    );
  }

  it('keeps the hedge 202 when every log sink throws', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('sink');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('sink');
    });
    const main = heldSend();
    const hedge = vi.fn<SendFn>().mockResolvedValue(undefined);
    const { ctx, pending } = executionContext();
    const work = handleFetch(publishRequest(), hedgeEnv(main.send, hedge), ctx);
    await untilHedgeDue();
    expect((await work).status).toBe(202);
    main.settle.resolve(undefined);
    await Promise.all(pending);
  });
});
