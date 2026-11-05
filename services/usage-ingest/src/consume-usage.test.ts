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
  it('captures handler entry and slot wait for a later mixed-batch message', async () => {
    const { fetch, processingLogs } = setup();
    let monotonic = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const held = Promise.withResolvers<Response>();
    fetch.mockReturnValueOnce(held.promise).mockImplementationOnce(async () => {
      monotonic = 1400;
      return new Response(null, { status: 429 });
    });
    const later = { ...usage, core: { ...usage.core, id: '4f2504e0-4f89-11d3-9a0c-0305e82c3302' } };
    const messages = [message(), { ...message(later), id: 'queue-2', attempts: 3 }];
    messages.forEach(msg => {
      msg.timestamp = new Date(9_000);
    });
    let finished = false;
    const work = Promise.resolve(worker.queue(batch(messages), env)).then(
      () => {
        finished = true;
      },
      error => {
        finished = true;
        return error;
      }
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    monotonic = 1350;
    wall.mockReturnValue(10_200);
    held.resolve(acknowledgement());
    expect(await work).toMatchObject({ message: 'Usage writer overloaded (HTTP 429/503)' });
    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[1].retry).toHaveBeenCalledOnce();
    expect(
      processingLogs().find(
        log => log.event === 'usage_ingest_processing' && log.usage_id === later.core.id
      )
    ).toMatchObject({
      queue_message_id: 'queue-2',
      delivery_attempts: 3,
      handler_entry_queue_age_ms: 1000,
      slot_wait_ms: 1250,
      queue_wait_ms: 1200,
      writer_duration_ms: 50,
    });
  });

  it('adds phase fields only to sampled or slow outcomes', async () => {
    const { fetch, processingLogs } = setup();
    vi.spyOn(performance, 'now').mockReturnValue(100);
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    fetch.mockResolvedValue(acknowledgement());
    const sampled = { ...message(), id: 'queue-92', timestamp: new Date(10_000) };
    const other = { ...message(), id: 'queue-1', timestamp: new Date(10_000) };
    await worker.queue(batch([sampled, other]), env);
    const logs = processingLogs().filter(log => log.event === 'usage_ingest_processing');
    expect(logs[0]).toMatchObject({ handler_entry_queue_age_ms: 0, slot_wait_ms: 0 });
    expect(logs[1]).not.toHaveProperty('handler_entry_queue_age_ms');
    expect(logs[1]).not.toHaveProperty('slot_wait_ms');
  });

  it('selects a slow queue wait even when its components are below the threshold', async () => {
    const { fetch, processingLogs } = setup();
    let monotonic = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const held = Promise.withResolvers<Response>();
    fetch.mockReturnValueOnce(held.promise).mockResolvedValueOnce(acknowledgement());
    const messages = [message(), message()];
    messages.forEach(msg => {
      msg.timestamp = new Date(9_400);
    });
    const work = worker.queue(batch(messages), env);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    monotonic = 600;
    wall.mockReturnValue(10_600);
    held.resolve(acknowledgement());
    await work;
    expect(
      processingLogs().filter(log => log.event === 'usage_ingest_processing')[1]
    ).toMatchObject({
      handler_entry_queue_age_ms: 600,
      slot_wait_ms: 500,
      queue_wait_ms: 1200,
      writer_duration_ms: 0,
    });
  });

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
    expect(processingLogs().filter(log => log.event === 'usage_ingest_processing')).toEqual([]);
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
    expect(processingLogs().filter(log => log.event === 'usage_ingest_processing')).toEqual([
      {
        level: 'info',
        event: 'usage_ingest_processing',
        queue: 'usage',
        batch_id: expect.any(String),
        batch_size: 2,
        handler_entry_at_ms: timestamp + 2000,
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
        batch_id: expect.any(String),
        batch_size: 2,
        handler_entry_at_ms: timestamp + 2000,
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
      String(value).startsWith('{') && JSON.parse(String(value)).event === 'usage_ingest_processing'
        ? [logs[1].mock.invocationCallOrder[index]]
        : []
    );
    expect(outcomeLogOrders).toHaveLength(2);
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
      const outcomes = processingLogs().filter(log => log.event === 'usage_ingest_processing');
      expect(outcomes).toEqual([
        expect.objectContaining({
          level: 'warn',
          batch_id: expect.any(String),
          batch_size: 1,
          handler_entry_at_ms: expect.any(Number),
          queue_action: 'retry',
          reason: failure === 'invalid' ? 'invalid_event' : 'missing_config',
        }),
      ]);
      expect(outcomes[0]).not.toHaveProperty('writer_duration_ms');
      if (failure === 'invalid') {
        expect(outcomes[0]).not.toHaveProperty('usage_id');
        expect(outcomes[0]).not.toHaveProperty('event_age_ms');
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
      expect(processingLogs().filter(log => log.event === 'usage_ingest_processing')).toEqual([
        {
          level: 'warn',
          event: 'usage_ingest_processing',
          queue: 'usage',
          batch_id: expect.any(String),
          batch_size: 1,
          handler_entry_at_ms: expect.any(Number),
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
      const infoEvents = logs[1].mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(infoEvents.map(event => event.event)).toEqual([
        'usage_ingest_handler_entry',
        'usage_ingest_batch_dispositions',
      ]);
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
      expect(
        processingLogs().find(
          log => log.event === 'usage_ingest_processing' && log.usage_id === events[1].core.id
        )
      ).toMatchObject({
        reason: 'http_error',
        queue_action: 'retry',
        writer_status: status,
        invocation_failure: 'writer_overloaded',
        usage_id: events[1].core.id,
      });
      for (const index of [0, 2, 3]) {
        expect(
          processingLogs().find(
            log => log.event === 'usage_ingest_processing' && log.usage_id === events[index].core.id
          )
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
      const [outcome] = processingLogs().filter(log => log.event === 'usage_ingest_processing');
      expect(outcome).toMatchObject({ reason: 'http_error', queue_action: 'retry' });
      expect(outcome).not.toHaveProperty('invocation_failure');
      expect(outcome).not.toHaveProperty('writer_status');
    }
  );

  it('clamps processing event age to zero when the event clock is ahead', async () => {
    const { fetch, processingLogs } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    fetch.mockResolvedValue(acknowledgement());
    await worker.queue(batch([message()]), env);
    expect(processingLogs().find(log => log.event === 'usage_ingest_processing').event_age_ms).toBe(
      0
    );
  });

  it.each(['1', '2'])('keeps ACKs on logging failure with parallelism %s', async parallelism => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    logs[1].mockImplementation(value => {
      if (String(value).startsWith('{')) throw new Error('synthetic logging failure');
    });
    const messages = [message(), message()];
    await expect(
      worker.queue(batch(messages), {
        ...env,
        USAGE_INGEST_PARALLELISM: parallelism,
      })
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const msg of messages) {
      expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });
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

  it('caps outstanding writes at two with out-of-order completion', async () => {
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
    const work = Promise.resolve(worker.queue(input, parallelEnv)).then(() => {
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
    expect(entries).toHaveLength(5);
    expect(outcomes).toHaveLength(5);
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
    expect(input.ackAll).not.toHaveBeenCalled();
    expect(input.retryAll).not.toHaveBeenCalled();
  });

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
      expect(processingLogs().filter(log => log.event === 'usage_ingest_processing')).toHaveLength(
        5
      );
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
    [429, 503].flatMap(status => ['processing', 'disposition'].map(origin => ({ status, origin })))
  )(
    'retains HTTP $status and the first $origin error after all items settle',
    async ({ status, origin }) => {
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

  it('propagates the original unexpected error without overload', async () => {
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
  });
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
      expect(
        processingLogs().find(
          log => log.event === 'usage_ingest_processing' && log.usage_id === inputEvents[2].core.id
        )
      ).toMatchObject({
        retry_class: 'admission',
        admission_reason: 'pool_busy',
        retry_delay_seconds: 4,
      });
      expect(
        processingLogs().find(
          log => log.event === 'usage_ingest_processing' && log.usage_id === inputEvents[5].core.id
        )
      ).toMatchObject({
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

function emittedEvents(logs: ReturnType<typeof setup>['logs']) {
  return logs.flatMap(log =>
    log.mock.calls.flatMap(([value]) => {
      if (typeof value !== 'string' || !value.startsWith('{')) return [];
      try {
        return [JSON.parse(value)];
      } catch {
        return [];
      }
    })
  );
}

describe('batch disposition summary', () => {
  const summaryEvents = (logs: ReturnType<typeof setup>['logs']) =>
    emittedEvents(logs).filter(log => log.event === 'usage_ingest_batch_dispositions');
  const summary = (logs: ReturnType<typeof setup>['logs']) => {
    const events = summaryEvents(logs);
    expect(events).toHaveLength(1);
    return events[0];
  };
  const summaryLogOrder = (logs: ReturnType<typeof setup>['logs']) =>
    logs.flatMap(log =>
      log.mock.calls.flatMap(([value], index) => {
        if (typeof value !== 'string' || !value.startsWith('{')) return [];
        const parsed = JSON.parse(value);
        return parsed.event === 'usage_ingest_batch_dispositions'
          ? [log.mock.invocationCallOrder[index]]
          : [];
      })
    );

  it('summarizes an all-recorded batch once after every ACK, without message identity', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    const messages = [message(), message()];
    messages.forEach(msg => {
      msg.timestamp = new Date(5_000);
    });
    await worker.queue(batch(messages), env);
    expect(messages.every(msg => msg.ack.mock.calls.length === 1)).toBe(true);
    expect(summary(logs)).toEqual({
      level: 'info',
      event: 'usage_ingest_batch_dispositions',
      queue: 'usage',
      batch_id: expect.any(String),
      batch_size: 2,
      messages_started_n: 2,
      processing_exception_n: 0,
      ack_called_n: 2,
      ack_exception_n: 0,
      retry_called_n: 0,
      retry_exception_n: 0,
      overloaded: false,
      invocation_result: 'return',
      earliest_message_timestamp_ms: 5_000,
      latest_message_timestamp_ms: 5_000,
      delivery_attempts_unknown_n: 0,
      delivery_attempt_1_n: 2,
      delivery_attempt_2_n: 0,
      delivery_attempt_3_n: 0,
      delivery_attempt_4_n: 0,
      delivery_attempt_5_n: 0,
      delivery_attempt_6_plus_n: 0,
    });
    expect(summary(logs).batch_id).toBe(
      emittedEvents(logs).find(log => log.event === 'usage_ingest_processing').batch_id
    );
    expect(Object.keys(summary(logs)).toSorted()).toEqual(
      [
        'ack_called_n',
        'ack_exception_n',
        'batch_id',
        'batch_size',
        'delivery_attempt_1_n',
        'delivery_attempt_2_n',
        'delivery_attempt_3_n',
        'delivery_attempt_4_n',
        'delivery_attempt_5_n',
        'delivery_attempt_6_plus_n',
        'delivery_attempts_unknown_n',
        'earliest_message_timestamp_ms',
        'event',
        'invocation_result',
        'latest_message_timestamp_ms',
        'level',
        'messages_started_n',
        'overloaded',
        'processing_exception_n',
        'queue',
        'retry_called_n',
        'retry_exception_n',
      ].toSorted()
    );
    const summaryOrder = summaryLogOrder(logs)[0];
    for (const msg of messages)
      expect(summaryOrder).toBeGreaterThan(msg.ack.mock.invocationCallOrder[0]);
    const serialized = JSON.stringify(summary(logs));
    for (const msg of messages) expect(serialized).not.toContain(msg.id);
    for (const sensitive of [usage.core.id, usage.core.kilo_user_id, writerSecret])
      expect(serialized).not.toContain(sensitive);
  });

  it('records all-duplicate redeliveries at attempt 2 as ACK calls', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement('duplicate'));
    const messages = [message(), message(), message()];
    messages.forEach(msg => {
      msg.attempts = 2;
      msg.timestamp = new Date(7_000);
    });
    await worker.queue(batch(messages), env);
    expect(messages.every(msg => msg.ack.mock.calls.length === 1)).toBe(true);
    expect(messages.every(msg => msg.retry.mock.calls.length === 0)).toBe(true);
    expect(summary(logs)).toMatchObject({
      batch_size: 3,
      messages_started_n: 3,
      ack_called_n: 3,
      retry_called_n: 0,
      overloaded: false,
      invocation_result: 'return',
      delivery_attempt_1_n: 0,
      delivery_attempt_2_n: 3,
    });
  });

  it.each([429, 503])(
    'logs the mixed HTTP %s outcome after dispositions and before the overload throw',
    async status => {
      const { fetch, logs } = setup();
      fetch
        .mockResolvedValueOnce(acknowledgement())
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(acknowledgement('duplicate'))
        .mockResolvedValueOnce(new Response(null, { status: 400 }));
      const messages = [message(), message(), message(), message()];
      const failure = await worker.queue(batch(messages), env).catch(error => error);
      expect(failure.message).toBe('Usage writer overloaded (HTTP 429/503)');
      expect(messages.map(msg => msg.ack.mock.calls.length)).toEqual([1, 0, 1, 0]);
      expect(messages.map(msg => msg.retry.mock.calls.length)).toEqual([0, 1, 0, 1]);
      const [summaryOrder] = summaryLogOrder(logs);
      const summaryEvent = summary(logs);
      expect(summaryEvent).toMatchObject({
        batch_size: 4,
        messages_started_n: 4,
        processing_exception_n: 0,
        ack_called_n: 2,
        ack_exception_n: 0,
        retry_called_n: 2,
        retry_exception_n: 0,
        overloaded: true,
        invocation_result: 'overload_throw',
      });
      for (const msg of messages) {
        const dispositionOrder = [
          ...msg.ack.mock.invocationCallOrder,
          ...msg.retry.mock.invocationCallOrder,
        ];
        expect(summaryOrder).toBeGreaterThan(dispositionOrder[0]);
      }
    }
  );

  it.each([429, 503])(
    'logs the mixed HTTP %s outcome through the parallel slots before the overload throw',
    async status => {
      const { fetch, logs } = setup();
      fetch
        .mockResolvedValueOnce(acknowledgement())
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(new Response(null, { status: 400 }));
      const messages = [message(), message(), message()];
      const input = batch(messages);
      await expect(worker.queue(input, { ...env, USAGE_INGEST_PARALLELISM: '2' })).rejects.toThrow(
        'Usage writer overloaded'
      );
      expect(messages.map(msg => msg.ack.mock.calls.length)).toEqual([1, 0, 0]);
      expect(messages.map(msg => msg.retry.mock.calls.length)).toEqual([0, 1, 1]);
      expect(input.ackAll).not.toHaveBeenCalled();
      expect(input.retryAll).not.toHaveBeenCalled();
      expect(summary(logs)).toMatchObject({
        batch_size: 3,
        ack_called_n: 1,
        retry_called_n: 2,
        overloaded: true,
        invocation_result: 'overload_throw',
      });
    }
  );

  it.each([
    ['mismatched', 'invalid_response'],
    ['timeout', 'timeout'],
    ['malformed', 'invalid_response'],
  ] as const)('counts a settled %s write as a retry call and a return', async (failure, reason) => {
    const { fetch, logs } = setup();
    if (failure === 'timeout') {
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
      fetch.mockRejectedValue(new Error('synthetic transport failure'));
    } else
      fetch.mockResolvedValue(
        failure === 'malformed'
          ? Response.json({ secret: writerSecret })
          : acknowledgement('recorded', 'wrong-id')
      );
    const msg = message();
    await expect(worker.queue(batch([msg]), env)).resolves.toBeUndefined();
    expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(emittedEvents(logs).find(log => log.event === 'usage_ingest_processing')).toMatchObject({
      reason,
    });
    expect(summary(logs)).toMatchObject({
      messages_started_n: 1,
      ack_called_n: 0,
      retry_called_n: 1,
      processing_exception_n: 0,
      overloaded: false,
      invocation_result: 'return',
    });
  });

  it.each([
    ['invalid', 'invalid_event'],
    ['missing_url', 'missing_config'],
  ] as const)('counts an %s payload as a retry call', async (failure, reason) => {
    const { fetch, logs } = setup();
    const msg = message(failure === 'invalid' ? { core: { id: 'sensitive-invalid-id' } } : usage);
    await worker.queue(batch([msg]), {
      ...env,
      ...(failure === 'missing_url' ? { USAGE_WRITER_URL: undefined } : {}),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(emittedEvents(logs).find(log => log.event === 'usage_ingest_processing')).toMatchObject({
      reason,
    });
    expect(summary(logs)).toMatchObject({
      messages_started_n: 1,
      ack_called_n: 0,
      retry_called_n: 1,
      processing_exception_n: 0,
      invocation_result: 'return',
    });
    expect(JSON.stringify(summary(logs))).not.toContain('sensitive-invalid-id');
  });

  it('summarizes an empty batch explicitly without any dispositions', async () => {
    const { fetch, logs } = setup();
    await worker.queue(batch([]), { ...env, USAGE_INGEST_PARALLELISM: '2' });
    expect(fetch).not.toHaveBeenCalled();
    expect(summary(logs)).toEqual({
      level: 'info',
      event: 'usage_ingest_batch_dispositions',
      queue: 'usage',
      batch_id: expect.any(String),
      batch_size: 0,
      messages_started_n: 0,
      processing_exception_n: 0,
      ack_called_n: 0,
      ack_exception_n: 0,
      retry_called_n: 0,
      retry_exception_n: 0,
      overloaded: false,
      invocation_result: 'return',
      delivery_attempts_unknown_n: 0,
      delivery_attempt_1_n: 0,
      delivery_attempt_2_n: 0,
      delivery_attempt_3_n: 0,
      delivery_attempt_4_n: 0,
      delivery_attempt_5_n: 0,
      delivery_attempt_6_plus_n: 0,
    });
  });

  it('summarizes a partial batch where one message throws and later messages continue', async () => {
    const { fetch, logs } = setup();
    const events = ['41', '42', '43'].map(suffix => ({
      ...usage,
      core: { ...usage.core, id: `4f2504e0-4f89-41d3-9a0c-0305e82c33${suffix}` },
    }));
    const messages = events.map(item => message(item));
    fetch.mockImplementation(async (_url, options) => {
      const id = JSON.parse(options?.body as string).core.id;
      return id === events[1].core.id
        ? Response.json({ secret: 'sensitive-response' })
        : acknowledgement('recorded', id);
    });
    const failure = new Error('synthetic retry failure');
    messages[1].retry.mockImplementation(() => {
      throw failure;
    });
    const input = batch(messages);
    const propagated = await Promise.resolve(
      worker.queue(input, { ...env, USAGE_INGEST_PARALLELISM: '2' })
    ).catch(error => error);
    expect(messages.map(msg => msg.ack.mock.calls.length)).toEqual([1, 0, 1]);
    expect(messages.map(msg => msg.retry.mock.calls.length)).toEqual([0, 1, 0]);
    expect(propagated).toBe(failure);
    expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
    expect(messages[1].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(messages[1].ack).not.toHaveBeenCalled();
    expect(messages[2].ack).toHaveBeenCalledExactlyOnceWith();
    expect(input.ackAll).not.toHaveBeenCalled();
    expect(input.retryAll).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(summary(logs)).toMatchObject({
      batch_size: 3,
      messages_started_n: 3,
      processing_exception_n: 0,
      ack_called_n: 2,
      ack_exception_n: 0,
      retry_called_n: 1,
      retry_exception_n: 1,
      overloaded: false,
      invocation_result: 'exception_throw',
      delivery_attempts_unknown_n: 0,
      delivery_attempt_1_n: 3,
    });
    const serialized = JSON.stringify(summary(logs));
    expect(serialized).not.toContain('sensitive-response');
    expect(serialized).not.toContain('synthetic retry failure');
  });

  it('rethrows the original ACK error and labels the invocation as an exception throw', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    const failure = new Error('ack failed');
    const messages = [message(), message()];
    messages[0].ack.mockImplementation(() => {
      throw failure;
    });
    const propagated = await Promise.resolve(
      worker.queue(batch(messages), { ...env, USAGE_INGEST_PARALLELISM: '2' })
    ).catch(error => error);
    expect(propagated).toBe(failure);
    expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(messages[1].ack).toHaveBeenCalledExactlyOnceWith();
    expect(summary(logs)).toMatchObject({
      ack_called_n: 2,
      ack_exception_n: 1,
      retry_called_n: 0,
      overloaded: false,
      invocation_result: 'exception_throw',
    });
  });

  it('rethrows the original retry error and counts the retry call and its exception', async () => {
    const { fetch, logs } = setup();
    fetch.mockResolvedValue(new Response(null, { status: 500 }));
    const failure = new Error('retry failed');
    const msg = message();
    msg.retry.mockImplementation(() => {
      throw failure;
    });
    const propagated = await worker.queue(batch([msg]), env).catch(error => error);
    expect(propagated).toBe(failure);
    expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(summary(logs)).toMatchObject({
      ack_called_n: 0,
      ack_exception_n: 0,
      retry_called_n: 1,
      retry_exception_n: 1,
      overloaded: false,
      invocation_result: 'exception_throw',
    });
  });

  it('counts a throwing fallback retry after a processing exception', async () => {
    const { fetch, logs } = setup();
    const failure = new Error('synthetic processing failure');
    const retryFailure = new Error('synthetic fallback retry failure');
    const msg = message();
    Object.defineProperty(msg, 'timestamp', {
      get() {
        throw failure;
      },
    });
    msg.retry.mockImplementation(() => {
      throw retryFailure;
    });
    const propagated = await worker.queue(batch([msg]), env).catch(error => error);
    expect(propagated).toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
    expect(summary(logs)).toMatchObject({
      batch_size: 1,
      messages_started_n: 1,
      processing_exception_n: 1,
      ack_called_n: 0,
      ack_exception_n: 0,
      retry_called_n: 1,
      retry_exception_n: 1,
      overloaded: false,
      invocation_result: 'exception_throw',
    });
    expect(JSON.stringify(summary(logs))).not.toContain('synthetic');
  });

  it.each([429, 503])(
    'retains HTTP %s as the original failure when a summary-independent ACK throws',
    async status => {
      const { fetch, logs } = setup();
      fetch
        .mockResolvedValueOnce(acknowledgement())
        .mockResolvedValueOnce(new Response(null, { status }));
      const failure = new Error('ack failed');
      const messages = [message(), message()];
      messages[0].ack.mockImplementation(() => {
        throw failure;
      });
      const propagated = await worker.queue(batch(messages), env).catch(error => error);
      expect(propagated.message).toBe(
        'Usage writer overloaded (HTTP 429/503); unexpected errors: 1'
      );
      expect(propagated.cause).toBe(failure);
      expect(messages[1].retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      expect(summary(logs)).toMatchObject({
        ack_called_n: 1,
        ack_exception_n: 1,
        retry_called_n: 1,
        overloaded: true,
        invocation_result: 'overload_throw',
      });
    }
  );

  it.each(['return', 'overload_throw', 'exception_throw'] as const)(
    'keeps the original %s outcome when the summary log sink throws',
    async outcome => {
      const { fetch, logs } = setup();
      const observed = logs.map(log => {
        const calls: unknown[][] = [];
        log.mockImplementation((value: unknown) => {
          calls.push([value]);
          if (String(value).startsWith('{')) throw new Error('synthetic logging failure');
        });
        return calls;
      });
      fetch.mockImplementation(async () =>
        outcome === 'return' ? acknowledgement() : new Response(null, { status: 429 })
      );
      const messages = [message(), message()];
      const result = await Promise.resolve(
        worker.queue(batch(messages), { ...env, USAGE_INGEST_PARALLELISM: '2' })
      ).then(
        () => undefined,
        error => error
      );
      if (outcome === 'return') expect(result).toBeUndefined();
      else expect(result).toMatchObject({ message: 'Usage writer overloaded (HTTP 429/503)' });
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const msg of messages) {
        if (outcome === 'return') expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
        else expect(msg.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
      }
      const summaryAttempts = observed
        .flat()
        .filter(value =>
          String(value).startsWith('{"level":"info","event":"usage_ingest_batch_dispositions"')
        );
      expect(summaryAttempts).toHaveLength(1);
    }
  );

  it('does not let a throwing message timestamp change delivery or the summary', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    const messages = [message(), message()];
    messages[0].timestamp = new Date(1_000);
    messages[1].timestamp = new Date(9_000);
    messages[1].ack.mockImplementation(() => {
      Object.defineProperty(messages[1], 'timestamp', {
        get() {
          throw new Error('synthetic timestamp failure');
        },
      });
    });
    await worker.queue(batch(messages), env);
    for (const msg of messages) expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
    for (const msg of messages) expect(msg.retry).not.toHaveBeenCalled();
    expect(summary(logs)).toMatchObject({
      batch_size: 2,
      ack_called_n: 2,
      earliest_message_timestamp_ms: 1_000,
      delivery_attempts_unknown_n: 0,
      delivery_attempt_1_n: 2,
    });
  });

  it('omits malformed timestamps and buckets attempts without unbounded keys', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    const messages = Array.from({ length: 6 }, () => message());
    messages.forEach((msg, index) => {
      msg.attempts = [1, 2, 3, 4, 100, 0][index];
    });
    messages[0].timestamp = new Date(Number.NaN);
    messages[1].timestamp = new Date(1_000);
    messages[2].timestamp = new Date(2_000);
    messages[3].timestamp = new Date(3_000);
    messages[4].timestamp = new Date(Number.POSITIVE_INFINITY);
    messages[5].timestamp = new Date(Number.NaN);
    messages[5].ack.mockImplementation(() => {
      Object.defineProperty(messages[5], 'attempts', {
        get() {
          throw new Error('synthetic attempts failure');
        },
      });
    });
    vi.spyOn(performance, 'now').mockReturnValue(100);
    await worker.queue(batch(messages), env);
    const summaryEvent = summary(logs);
    expect(summaryEvent).toMatchObject({
      batch_size: 6,
      ack_called_n: 6,
      earliest_message_timestamp_ms: 1_000,
      latest_message_timestamp_ms: 3_000,
      delivery_attempt_1_n: 1,
      delivery_attempt_2_n: 1,
      delivery_attempt_3_n: 1,
      delivery_attempt_4_n: 1,
      delivery_attempt_5_n: 0,
      delivery_attempt_6_plus_n: 1,
      delivery_attempts_unknown_n: 1,
    });
    const bucketed = Object.entries(summaryEvent)
      .filter(([key]) => /^delivery_attempts?_.*_n$/.test(key))
      .reduce((total, [, count]) => total + (count as number), 0);
    expect(bucketed).toBe(summaryEvent.batch_size);
  });

  it('keeps one summary per invocation and a distinct batch identity across batches', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    await worker.queue(batch([message()]), env);
    await worker.queue(batch([message(), message()]), env);
    const first = summaryEvents(logs);
    expect(first).toHaveLength(2);
    expect(first[0].batch_id).not.toBe(first[1].batch_id);
    expect(first.map(event => event.batch_size)).toEqual([1, 2]);
    expect(first.map(event => event.ack_called_n)).toEqual([1, 2]);
    expect(first.map(event => event.invocation_result)).toEqual(['return', 'return']);
  });
});
