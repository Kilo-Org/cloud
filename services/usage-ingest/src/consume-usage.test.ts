import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';

const writerSecret = 'synthetic-writer-secret';
const env = {
  USAGE_WRITER_URL: 'https://writer.test/api/internal/usage/record',
  USAGE_WRITER_SECRET: writerSecret,
  USAGE_WRITER_PROTECTION_BYPASS: 'synthetic-bypass',
} as Env;

function message(body: unknown = usage) {
  return { id: 'queue-1', timestamp: new Date(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
}
function batch(messages: Message<unknown>[]) {
  return {
    queue: 'usage',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  };
}
function acknowledgement(status = 'recorded', usageId = usage.core.id) {
  return Response.json({
    status,
    result: { usageId, createdAt: usage.core.created_at, newMicrodollarsUsed: 1234 },
  });
}
function setup() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn')];
  logs.forEach(log => log.mockImplementation(() => {}));
  const processingLogs = () =>
    logs.flatMap(log =>
      log.mock.calls
        .filter(([value]) => typeof value === 'string' && value.startsWith('{'))
        .map(([value]) => JSON.parse(value))
    );
  return { fetch, logs, processingLogs };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usage consumer', () => {
  it('waits for each validated acknowledgement before ACK and the next write', async () => {
    const { fetch, logs, processingLogs } = setup();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
    const timestamp = Date.parse(usage.core.created_at);
    vi.spyOn(Date, 'now').mockReturnValue(timestamp + 2000);
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const secondEvent = {
      ...usage,
      core: { ...usage.core, id: '4f2504e0-4f89-11d3-9a0c-0305e82c3302' },
      bouncer_usage_event: { request_id: 'request-2', payload: { spend: 1234 } },
    };
    const messages = [message({ ...usage, extra: 'strip-me' }), message(secondEvent)];
    messages.forEach(msg => {
      msg.timestamp = new Date(timestamp + 1500);
    });
    const work = worker.queue(batch(messages), env);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(messages[1].ack).not.toHaveBeenCalled();
    expect(processingLogs()).toEqual([]);
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual(usage);
    clock.mockReturnValue(375);
    vi.spyOn(Date, 'now').mockReturnValue(timestamp + 2275);
    first.resolve(acknowledgement());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
    expect(messages[1].ack).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual(secondEvent);
    clock.mockReturnValue(500);
    vi.spyOn(Date, 'now').mockReturnValue(timestamp + 2400);
    second.resolve(acknowledgement('duplicate', secondEvent.core.id));
    await work;
    expect(messages[1].ack).toHaveBeenCalledExactlyOnceWith();
    expect(messages.every(msg => msg.retry.mock.calls.length === 0)).toBe(true);
    expect(processingLogs()).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_processing',
        queue: 'usage',
        outcome: 'recorded',
        queue_action: 'ack',
        usage_id: usage.core.id,
        queue_message_id: messages[0].id,
        delivery_attempts: 1,
        queue_wait_ms: 500,
        event_age_ms: 2275,
        writer_duration_ms: 275,
      },
      {
        level: 'info',
        event: 'usage_ingest_processing',
        queue: 'usage',
        outcome: 'duplicate',
        queue_action: 'ack',
        usage_id: secondEvent.core.id,
        queue_message_id: messages[1].id,
        delivery_attempts: 1,
        queue_wait_ms: 775,
        event_age_ms: 2400,
        writer_duration_ms: 125,
      },
    ]);
    expect(logs[0]).not.toHaveBeenCalled();
    expect(logs[2]).not.toHaveBeenCalled();
    const outcomeLogOrders = logs[1].mock.calls.flatMap(([value], index) =>
      String(value).startsWith('{') ? [logs[1].mock.invocationCallOrder[index]] : []
    );
    messages.forEach((msg, index) =>
      expect(outcomeLogOrders[index]).toBeLessThan(msg.ack.mock.invocationCallOrder[0])
    );
    expect(fetch.mock.calls[0][1]?.headers).toEqual({
      'content-type': 'application/json',
      'x-internal-api-key': writerSecret,
      'x-usage-write-source': 'queue',
      'x-vercel-protection-bypass': env.USAGE_WRITER_PROTECTION_BYPASS,
    });
  });

  it.each(['invalid', 'missing_url', 'missing_secret'])(
    'retries %s without a writer call',
    async failure => {
      const { fetch, logs, processingLogs } = setup();
      const msg = message(failure === 'invalid' ? { core: { id: 'sensitive-invalid-id' } } : usage);
      await worker.queue(batch([msg]), {
        ...env,
        ...(failure === 'missing_url' ? { USAGE_WRITER_URL: undefined } : {}),
        ...(failure === 'missing_secret' ? { USAGE_WRITER_SECRET: undefined } : {}),
      });
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(fetch).not.toHaveBeenCalled();
      expect(processingLogs()).toEqual([
        expect.objectContaining({
          level: 'warn',
          queue_action: 'retry',
          reason: failure === 'invalid' ? 'invalid_event' : 'missing_config',
        }),
      ]);
      expect(processingLogs()[0]).not.toHaveProperty('writer_duration_ms');
      if (failure === 'invalid') {
        expect(processingLogs()[0]).not.toHaveProperty('usage_id');
        expect(processingLogs()[0]).not.toHaveProperty('event_age_ms');
      }
      expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(
        'sensitive-invalid-id'
      );
    }
  );

  it.each(['not_recorded', 'mismatched', 'malformed', 'unavailable', 'transport', 'timeout'])(
    'retries %s and logs only safe outcomes',
    async failure => {
      const { fetch, logs, processingLogs } = setup();
      vi.spyOn(performance, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(140);
      if (failure === 'transport' || failure === 'timeout') {
        if (failure === 'timeout')
          vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
        fetch.mockRejectedValue(new Error('sensitive-exception'));
      } else
        fetch.mockResolvedValue(
          failure === 'not_recorded'
            ? Response.json({ status: failure, result: null })
            : failure === 'mismatched'
              ? acknowledgement('recorded', 'wrong-id')
              : failure === 'malformed'
                ? Response.json({ secret: writerSecret })
                : new Response('sensitive-response', { status: 500 })
        );
      const msg = message({
        ...usage,
        metadata: { ...usage.metadata, user_prompt_prefix: 'sensitive-prompt' },
        bouncer_usage_event: {
          request_id: 'sensitive-request-id',
          payload: { secret: 'sensitive-bouncer-payload' },
        },
      });
      msg.attempts = 3;
      await worker.queue(batch([msg]), env);
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(processingLogs()).toEqual([
        {
          level: 'warn',
          event: 'usage_ingest_processing',
          queue: 'usage',
          outcome: 'unavailable',
          reason: expect.any(String),
          queue_action: 'retry',
          usage_id: usage.core.id,
          queue_message_id: msg.id,
          delivery_attempts: 3,
          queue_wait_ms: expect.any(Number),
          retry_class: 'conservative',
          retry_delay_seconds: 60,
          writer_duration_ms: 40,
          event_age_ms: expect.any(Number),
        },
      ]);
      expect(logs[0]).not.toHaveBeenCalled();
      expect(logs[1]).not.toHaveBeenCalled();
      expect(logs[2].mock.invocationCallOrder.at(-1)).toBeLessThan(
        msg.retry.mock.invocationCallOrder[0]
      );
      const serialized = JSON.stringify(logs.flatMap(log => log.mock.calls));
      for (const sensitive of [
        writerSecret,
        env.USAGE_WRITER_PROTECTION_BYPASS,
        env.USAGE_WRITER_URL,
        'sensitive-exception',
        'sensitive-response',
        'sensitive-prompt',
        'sensitive-request-id',
        'sensitive-bouncer-payload',
      ])
        expect(serialized).not.toContain(sensitive);
    }
  );

  it.each([429, 503])(
    'rejects writer HTTP %s after settling every mixed-batch item',
    async status => {
      const { fetch, logs, processingLogs } = setup();
      const events = Array.from({ length: 4 }, (_, index) => ({
        ...usage,
        core: { ...usage.core, id: `4f2504e0-4f89-41d3-9a0c-0305e82c330${index}` },
      }));
      fetch
        .mockResolvedValueOnce(acknowledgement('recorded', events[0].core.id))
        .mockResolvedValueOnce(new Response('sensitive-response', { status }))
        .mockResolvedValueOnce(new Response('sensitive-client-error', { status: 400 }))
        .mockResolvedValueOnce(acknowledgement('duplicate', events[3].core.id));
      const messages = events.map(event => message(event));
      const input = batch(messages);
      await expect(worker.queue(input, env)).rejects.toThrow('Usage writer overloaded');
      expect(fetch).toHaveBeenCalledTimes(4);
      for (const index of [0, 3]) {
        expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
        expect(messages[index].retry).not.toHaveBeenCalled();
      }
      for (const index of [1, 2]) {
        expect(messages[index].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
        expect(messages[index].ack).not.toHaveBeenCalled();
      }
      expect(input.ackAll).not.toHaveBeenCalled();
      expect(input.retryAll).not.toHaveBeenCalled();
      expect(fetch.mock.calls.map(([, options]) => JSON.parse(options?.body as string))).toEqual(
        events
      );
      expect(processingLogs().find(log => log.usage_id === events[1].core.id)).toMatchObject({
        reason: 'http_error',
        queue_action: 'retry',
        writer_status: status,
        invocation_failure: 'writer_overloaded',
        usage_id: events[1].core.id,
      });
      for (const index of [0, 2, 3]) {
        expect(
          processingLogs().find(log => log.usage_id === events[index].core.id)
        ).not.toHaveProperty('invocation_failure');
      }
      const serialized = JSON.stringify(logs.flatMap(log => log.mock.calls));
      for (const sensitive of [
        writerSecret,
        env.USAGE_WRITER_PROTECTION_BYPASS,
        env.USAGE_WRITER_URL,
        'sensitive-response',
        'sensitive-client-error',
        usage.metadata.user_prompt_prefix,
      ]) {
        expect(serialized).not.toContain(sensitive);
      }
    }
  );

  it.each([301, 400, 401, 403, 408, 500, 502, 504])(
    'retries HTTP %s without labelling it overload or failing the invocation',
    async status => {
      const { fetch, processingLogs } = setup();
      fetch.mockResolvedValue(new Response(null, { status }));
      const msg = message();
      await expect(worker.queue(batch([msg]), env)).resolves.toBeUndefined();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(msg.ack).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(processingLogs()[0]).toMatchObject({ reason: 'http_error', queue_action: 'retry' });
      expect(processingLogs()[0]).not.toHaveProperty('invocation_failure');
      expect(processingLogs()[0]).not.toHaveProperty('writer_status');
    }
  );

  it('clamps processing event age to zero when the event clock is ahead', async () => {
    const { fetch, processingLogs } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    fetch.mockResolvedValue(acknowledgement());
    await worker.queue(batch([message()]), env);
    expect(processingLogs()[0].event_age_ms).toBe(0);
  });

  it.each(
    [undefined, 'all'].flatMap(diagnostics =>
      ['1', '2'].map(parallelism => ({ diagnostics, parallelism }))
    )
  )(
    'keeps ACKs on logging failure with diagnostics $diagnostics and parallelism $parallelism',
    async ({ diagnostics, parallelism }) => {
      const { fetch, logs } = setup();
      fetch.mockImplementation(async () => acknowledgement());
      logs[1].mockImplementation(value => {
        if (String(value).startsWith('{')) throw new Error('synthetic logging failure');
      });
      const messages = [message(), message()];
      await expect(
        worker.queue(batch(messages), {
          ...env,
          USAGE_INGEST_DIAGNOSTICS: diagnostics,
          USAGE_INGEST_PARALLELISM: parallelism,
        })
      ).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const msg of messages) {
        expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
        expect(msg.retry).not.toHaveBeenCalled();
      }
    }
  );
});

describe('bounded parallel usage processing', () => {
  function events(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      ...usage,
      core: { ...usage.core, id: `4f2504e0-4f89-41d3-9a0c-0305e82c330${index}` },
    }));
  }
  const parallelEnv = { ...env, USAGE_INGEST_PARALLELISM: '2' };

  it.each([undefined, '1', '', '0', '-1', '3', '200', '2.0', 'unexpected'])(
    'defaults parallelism %s to one outstanding write',
    async parallelism => {
      const { fetch } = setup();
      const first = Promise.withResolvers<Response>();
      fetch.mockReturnValueOnce(first.promise).mockResolvedValue(acknowledgement());
      const messages = [message(), message()];
      const work = worker.queue(batch(messages), { ...env, USAGE_INGEST_PARALLELISM: parallelism });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(messages[0].ack).not.toHaveBeenCalled();
      first.resolve(acknowledgement());
      await work;
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const msg of messages) {
        expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
        expect(msg.retry).not.toHaveBeenCalled();
      }
    }
  );

  it.each([undefined, 'all'])(
    'caps outstanding writes at two with diagnostics %s and out-of-order completion',
    async diagnostics => {
      const { fetch, processingLogs } = setup();
      const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
      const inputEvents = events(5);
      const responses = inputEvents.map(() => Promise.withResolvers<Response>());
      let active = 0;
      let peak = 0;
      fetch.mockImplementation(() => {
        const index = fetch.mock.calls.length - 1;
        peak = Math.max(peak, ++active);
        return responses[index].promise.finally(() => active--);
      });
      const messages = inputEvents.map(event => message(event));
      const input = batch(messages);
      let finished = false;
      const work = Promise.resolve(
        worker.queue(input, { ...parallelEnv, USAGE_INGEST_DIAGNOSTICS: diagnostics })
      ).then(() => {
        finished = true;
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(messages.every(msg => msg.ack.mock.calls.length === 0)).toBe(true);
      // Leave the first writer pending while the other slot drains later messages.
      for (const index of [1, 2, 3, 4]) {
        now.mockReturnValue(10_000 + index * 1000);
        responses[index].resolve(
          acknowledgement(index === 1 ? 'duplicate' : 'recorded', inputEvents[index].core.id)
        );
        await vi.waitFor(() => expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith());
        expect(fetch).toHaveBeenCalledTimes(Math.min(index + 2, 5));
        expect(messages[0].ack).not.toHaveBeenCalled();
        expect(finished).toBe(false);
      }
      responses[0].resolve(acknowledgement('recorded', inputEvents[0].core.id));
      await work;
      expect(peak).toBe(2);
      expect(active).toBe(0);
      expect(finished).toBe(true);
      for (const msg of messages) {
        expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
        expect(msg.retry).not.toHaveBeenCalled();
      }
      const entries = processingLogs().filter(log => log.event === 'usage_ingest_handler_entry');
      const outcomes = processingLogs().filter(log => log.event === 'usage_ingest_processing');
      expect(entries).toHaveLength(diagnostics === 'all' ? 5 : 0);
      expect(outcomes).toHaveLength(5);
      if (diagnostics === 'all') {
        expect(new Set(entries.map(log => log.batch_id)).size).toBe(1);
        expect(entries[0].batch_id).toEqual(expect.any(String));
        expect(entries.map(log => log.handler_entry_at_ms)).toEqual(Array(5).fill(10_000));
        expect(entries.map(log => log.message_start_at_ms)).toEqual([
          10_000, 10_000, 11_000, 12_000, 13_000,
        ]);
        for (const log of [...entries, ...outcomes]) {
          expect(log).toMatchObject({
            queue: input.queue,
            batch_id: entries[0].batch_id,
            batch_size: 5,
            handler_entry_at_ms: 10_000,
          });
        }
      }
      expect(input.ackAll).not.toHaveBeenCalled();
      expect(input.retryAll).not.toHaveBeenCalled();
    }
  );

  it.each([429, 503])(
    'waits for all dispositions before rejecting concurrent HTTP %s overload',
    async status => {
      const { fetch, processingLogs } = setup();
      const inputEvents = events(5);
      const pending = Promise.withResolvers<Response>();
      fetch
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(new Response(null, { status: 400 }))
        .mockResolvedValueOnce(acknowledgement('duplicate', inputEvents[4].core.id));
      const messages = inputEvents.map((event, index) => message(index === 3 ? null : event));
      const input = batch(messages);
      let finished = false;
      const work = Promise.resolve(worker.queue(input, parallelEnv)).then(
        () => {
          finished = true;
          return undefined;
        },
        error => {
          finished = true;
          return error;
        }
      );
      await vi.waitFor(() => expect(messages[4].ack).toHaveBeenCalledExactlyOnceWith());
      expect(finished).toBe(false);
      expect(messages[0].ack).not.toHaveBeenCalled();
      pending.resolve(acknowledgement('recorded', inputEvents[0].core.id));
      const failure = await work;
      expect(failure).toMatchObject({ message: 'Usage writer overloaded (HTTP 429/503)' });
      expect(failure).not.toHaveProperty('cause');
      expect(fetch).toHaveBeenCalledTimes(4);
      for (const index of [0, 4]) {
        expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
        expect(messages[index].retry).not.toHaveBeenCalled();
      }
      for (const index of [1, 2, 3]) {
        expect(messages[index].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
        expect(messages[index].ack).not.toHaveBeenCalled();
      }
      expect(processingLogs()).toHaveLength(5);
      expect(processingLogs().filter(log => log.invocation_failure)).toEqual([
        expect.objectContaining({ writer_status: status, invocation_failure: 'writer_overloaded' }),
      ]);
      expect(input.ackAll).not.toHaveBeenCalled();
      expect(input.retryAll).not.toHaveBeenCalled();
    }
  );

  it('waits for a pending peer after an unexpected throw, retries it once and continues later messages', async () => {
    const { fetch } = setup();
    const inputEvents = events(3);
    const pending = Promise.withResolvers<Response>();
    fetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(acknowledgement('duplicate', inputEvents[2].core.id));
    const messages = inputEvents.map(event => message(event));
    const failure = new Error('synthetic processing failure');
    Object.defineProperty(messages[1], 'timestamp', {
      get() {
        throw failure;
      },
    });
    let finished = false;
    const work = Promise.resolve(worker.queue(batch(messages), parallelEnv)).catch(error => {
      finished = true;
      return error;
    });
    await vi.waitFor(() => expect(messages[2].ack).toHaveBeenCalledExactlyOnceWith());
    expect(messages[1].retry).toHaveBeenCalledExactlyOnceWith();
    expect(messages[1].ack).not.toHaveBeenCalled();
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(finished).toBe(false);
    pending.resolve(acknowledgement('recorded', inputEvents[0].core.id));
    expect(await work).toBe(failure);
    for (const index of [0, 2]) {
      expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
      expect(messages[index].retry).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preserves attempted dispositions when a queue method throws and completes later messages', async () => {
    const { fetch } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    const messages = [message(), message(), message()];
    messages[0].ack.mockImplementation(() => {
      throw new Error('ack failed');
    });
    await expect(worker.queue(batch(messages), parallelEnv)).rejects.toThrow('ack failed');
    for (const msg of messages) {
      expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
      expect(msg.retry).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('completes an empty batch without writer calls', async () => {
    const { fetch } = setup();
    await worker.queue(batch([]), parallelEnv);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('overload with simultaneous unexpected processing or disposition failure', () => {
  it.each(
    [undefined, 'all'].flatMap(diagnostics =>
      [429, 503].flatMap(status =>
        ['processing', 'disposition'].map(origin => ({ diagnostics, status, origin }))
      )
    )
  )(
    'retains HTTP $status and the first $origin error with diagnostics $diagnostics after all items settle',
    async ({ diagnostics, status, origin }) => {
      const { fetch } = setup();
      const inputEvents = Array.from({ length: 4 }, (_, index) => ({
        ...usage,
        core: { ...usage.core, id: `4f2504e0-4f89-41d3-9a0c-0305e82c330${index}` },
      }));
      const first = Promise.withResolvers<Response>();
      fetch
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          acknowledgement(
            origin === 'disposition' ? 'recorded' : 'duplicate',
            inputEvents[origin === 'disposition' ? 2 : 3].core.id
          )
        );
      if (origin === 'disposition')
        fetch.mockResolvedValueOnce(acknowledgement('duplicate', inputEvents[3].core.id));
      const messages = inputEvents.map((event, index) => ({
        ...message(event),
        id: `queue-${index}`,
      }));
      const unexpected = new Error(`synthetic ${origin} failure`);
      if (origin === 'processing')
        Object.defineProperty(messages[2], 'timestamp', {
          get() {
            throw unexpected;
          },
        });
      else
        messages[2].ack.mockImplementation(() => {
          throw unexpected;
        });
      const input = batch(messages);
      let finished = false;
      const work = Promise.resolve(
        worker.queue(input, {
          ...env,
          USAGE_INGEST_PARALLELISM: '2',
          USAGE_INGEST_DIAGNOSTICS: diagnostics,
        })
      ).then(
        () => {
          finished = true;
          return undefined;
        },
        error => {
          finished = true;
          return error;
        }
      );
      await vi.waitFor(() => expect(messages[3].ack).toHaveBeenCalledExactlyOnceWith());
      expect(finished).toBe(false);
      expect(messages[0].ack).not.toHaveBeenCalled();
      first.resolve(acknowledgement('recorded', inputEvents[0].core.id));
      const failure = await work;
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe('Usage writer overloaded (HTTP 429/503); unexpected errors: 1');
      expect(failure.cause).toBe(unexpected);
      for (const index of [0, 3]) {
        expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
        expect(messages[index].retry).not.toHaveBeenCalled();
      }
      expect(messages[1].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(messages[1].ack).not.toHaveBeenCalled();
      if (origin === 'processing') {
        expect(messages[2].retry).toHaveBeenCalledExactlyOnceWith();
        expect(messages[2].ack).not.toHaveBeenCalled();
      } else {
        expect(messages[2].ack).toHaveBeenCalledExactlyOnceWith();
        expect(messages[2].retry).not.toHaveBeenCalled();
      }
      expect(fetch).toHaveBeenCalledTimes(origin === 'processing' ? 3 : 4);
      expect(input.ackAll).not.toHaveBeenCalled();
      expect(input.retryAll).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, 'all'])(
    'propagates the original unexpected error without overload with diagnostics %s',
    async diagnostics => {
      const { fetch } = setup();
      fetch.mockImplementation(async () => acknowledgement());
      const unexpected = new Error('synthetic processing failure');
      const messages = [message(), message(), message()];
      Object.defineProperty(messages[1], 'timestamp', {
        get() {
          throw unexpected;
        },
      });
      const input = batch(messages);
      const failure = await Promise.resolve(
        worker.queue(input, {
          ...env,
          USAGE_INGEST_PARALLELISM: '2',
          USAGE_INGEST_DIAGNOSTICS: diagnostics,
        })
      ).catch(error => error);
      expect(failure).toBe(unexpected);
      expect(messages[1].retry).toHaveBeenCalledExactlyOnceWith();
      expect(messages[1].ack).not.toHaveBeenCalled();
      for (const index of [0, 2]) {
        expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
        expect(messages[index].retry).not.toHaveBeenCalled();
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(input.ackAll).not.toHaveBeenCalled();
      expect(input.retryAll).not.toHaveBeenCalled();
    }
  );
});

describe('native retry classification and launch budget', () => {
  it.each(['mismatched', 'timeout', 'malformed'] as const)(
    'settles six items with two slots, classified retries and an ambiguous %s',
    async failure => {
      const { fetch, processingLogs } = setup();
      const inputEvents = Array.from({ length: 6 }, (_, index) => ({
        ...usage,
        core: { ...usage.core, id: `4f2504e0-4f89-41d3-9a0c-0305e82c330${index}` },
      }));
      const held = Promise.withResolvers<Response>();
      fetch.mockImplementation(async (_url, options) => {
        const event = JSON.parse(options?.body as string);
        const index = inputEvents.findIndex(input => input.core.id === event.core.id);
        if (index === 0) return held.promise;
        if (index === 1) return acknowledgement('duplicate', event.core.id);
        if (index === 2)
          return Response.json(
            { error: 'Usage writer overloaded', reason: 'pool_busy' },
            { status: 429 }
          );
        if (index === 3) return new Response('<html>sensitive-response</html>', { status: 429 });
        if (index === 4) return new Response(null, { status: 503 });
        if (failure === 'timeout') {
          if (options?.signal instanceof AbortSignal) {
            // A pre-aborted fixture retains the real client's timeout classification.
            throw new Error('synthetic transport failure');
          }
        }
        return failure === 'malformed'
          ? Response.json({ secret: 'sensitive-response' })
          : acknowledgement('recorded', 'wrong-id');
      });
      if (failure === 'timeout') {
        const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
        let signals = 0;
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms =>
          ++signals === 6 ? AbortSignal.abort() : nativeTimeout(ms)
        );
      }
      const messages = inputEvents.map((event, index) => ({
        ...message(event),
        id: `queue-${index}`,
        attempts: index + 1,
      }));
      let finished = false;
      const work = Promise.resolve(
        worker.queue(batch(messages), { ...env, USAGE_INGEST_PARALLELISM: '2' })
      ).catch(error => {
        finished = true;
        return error;
      });
      await vi.waitFor(() => expect(messages[5].retry).toHaveBeenCalledTimes(1));
      expect(messages[1].ack).toHaveBeenCalledExactlyOnceWith();
      expect(finished).toBe(false);
      expect(messages[0].ack).not.toHaveBeenCalled();
      held.resolve(acknowledgement('recorded', inputEvents[0].core.id));
      expect(await work).toMatchObject({ message: 'Usage writer overloaded (HTTP 429/503)' });
      expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
      expect(messages[2].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 4 });
      for (const index of [3, 4, 5])
        expect(messages[index].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      for (const index of [0, 1]) expect(messages[index].retry).not.toHaveBeenCalled();
      for (const index of [2, 3, 4, 5]) expect(messages[index].ack).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(6);
      expect(fetch.mock.calls.map(([, options]) => JSON.parse(options?.body as string))).toEqual(
        inputEvents
      );
      expect(processingLogs().find(log => log.usage_id === inputEvents[2].core.id)).toMatchObject({
        retry_class: 'admission',
        admission_reason: 'pool_busy',
        retry_delay_seconds: 4,
      });
      expect(processingLogs().find(log => log.usage_id === inputEvents[5].core.id)).toMatchObject({
        reason: failure === 'timeout' ? 'timeout' : 'invalid_response',
        retry_class: 'conservative',
      });
    }
  );

  it.each([659_999, 660_000, 660_001])(
    'requires at least180 seconds remaining at elapsed %s',
    async elapsed => {
      const { fetch, processingLogs } = setup();
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      fetch.mockImplementation(async () => {
        now = elapsed;
        return acknowledgement();
      });
      const messages = [message(), message()];
      await worker.queue(batch(messages), env);
      const launched = elapsed <= 660_000;
      expect(fetch).toHaveBeenCalledTimes(launched ? 2 : 1);
      expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
      if (launched) expect(messages[1].ack).toHaveBeenCalledExactlyOnceWith();
      else {
        expect(messages[1].ack).not.toHaveBeenCalled();
        expect(messages[1].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
        expect(processingLogs().at(-1)).toMatchObject({
          reason: 'invocation_budget',
          retry_class: 'conservative',
        });
        expect(processingLogs().at(-1)).not.toHaveProperty('writer_duration_ms');
        expect(processingLogs().at(-1)).not.toHaveProperty('invocation_failure');
      }
    }
  );

  it('stops launching a growing batch in parallelism1 fallback without shortening any HTTP timeout', async () => {
    const { fetch } = setup();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetch.mockImplementation(async () => {
      now += 160_000;
      return acknowledgement();
    });
    const messages = Array.from({ length: 9 }, () => message());
    await worker.queue(batch(messages), env);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(timeout.mock.calls).toEqual(Array.from({ length: 5 }, () => [160_000]));
    expect(now).toBe(800_000);
    for (const msg of messages.slice(0, 5)) expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
    for (const msg of messages.slice(5)) {
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    }
  });

  it('keeps six slow successes in three parallel waves with no retries or local extra calls', async () => {
    const { fetch } = setup();
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const pending = Array.from({ length: 6 }, () => Promise.withResolvers<Response>());
    pending.forEach(item => fetch.mockReturnValueOnce(item.promise));
    const messages = Array.from({ length: 6 }, () => message());
    const work = worker.queue(batch(messages), { ...env, USAGE_INGEST_PARALLELISM: '2' });
    for (let wave = 0; wave < 3; wave++) {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes((wave + 1) * 2));
      now = (wave + 1) * 160_000;
      pending[wave * 2].resolve(acknowledgement());
      pending[wave * 2 + 1].resolve(acknowledgement());
    }
    await work;
    expect(now).toBe(480_000);
    expect(fetch).toHaveBeenCalledTimes(6);
    for (const msg of messages) {
      expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });
});
