import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import type { Env } from './publish-usage';
import { usage } from './usage.test-fixture';

const writerSecret = 'synthetic-writer-secret';
const env = {
  USAGE_INGEST_MODE: 'processing',
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

describe('usage consumer mode', () => {
  it.each([undefined, 'receipt'])('keeps %s receipt behavior without writer calls', async mode => {
    const { fetch } = setup();
    const messages = [message(), message(null)];
    await worker.queue(batch(messages), { ...env, USAGE_INGEST_MODE: mode });
    for (const msg of messages) {
      expect(msg.ack).toHaveBeenCalledExactlyOnceWith();
      expect(msg.retry).not.toHaveBeenCalled();
    }
    expect(fetch).not.toHaveBeenCalled();
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

  it.each(['', 'unexpected'])('retries unknown mode %s without network or ACK', async mode => {
    const { fetch, logs, processingLogs } = setup();
    const msg = message();
    await worker.queue(batch([msg]), { ...env, USAGE_INGEST_MODE: mode });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
    expect(fetch).not.toHaveBeenCalled();
    expect(processingLogs()).toEqual([
      expect.objectContaining({ level: 'warn', reason: 'invalid_mode', queue_action: 'retry' }),
    ]);
    expect(processingLogs()[0]).not.toHaveProperty('writer_duration_ms');
    expect(logs[0]).not.toHaveBeenCalled();
    expect(logs[1]).not.toHaveBeenCalled();
    expect(logs[2]).toHaveBeenCalledTimes(1);
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
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
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
      vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(140);
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
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(processingLogs()).toEqual([
        {
          level: 'warn',
          event: 'usage_ingest_processing',
          outcome: 'unavailable',
          reason: expect.any(String),
          queue_action: 'retry',
          usage_id: usage.core.id,
          queue_message_id: msg.id,
          delivery_attempts: 3,
          queue_wait_ms: expect.any(Number),
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
        expect(messages[index].retry).toHaveBeenCalledExactlyOnceWith();
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
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
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

  it('retries unexpected processing exceptions and still settles later messages', async () => {
    const { fetch, logs } = setup();
    fetch.mockImplementation(async () => acknowledgement());
    logs[1].mockImplementation(value => {
      if (String(value).startsWith('{')) throw new Error('synthetic logging failure');
    });
    const messages = [message(), message()];
    await expect(worker.queue(batch(messages), env)).rejects.toThrow('synthetic logging failure');
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const msg of messages) {
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
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

  it('caps outstanding writes at two and handles out-of-order completion without early ACK or return', async () => {
    const { fetch } = setup();
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
      expect(await work).toMatchObject({ message: 'Usage writer overloaded (HTTP 429/503)' });
      expect(fetch).toHaveBeenCalledTimes(4);
      for (const index of [0, 4]) {
        expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
        expect(messages[index].retry).not.toHaveBeenCalled();
      }
      for (const index of [1, 2, 3]) {
        expect(messages[index].retry).toHaveBeenCalledExactlyOnceWith();
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
    const { fetch, logs } = setup();
    const inputEvents = events(3);
    const pending = Promise.withResolvers<Response>();
    fetch
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(acknowledgement('recorded', inputEvents[1].core.id))
      .mockResolvedValueOnce(acknowledgement('duplicate', inputEvents[2].core.id));
    logs[1].mockImplementation(value => {
      if (
        String(value).startsWith('{') &&
        JSON.parse(String(value)).usage_id === inputEvents[1].core.id
      )
        throw new Error('synthetic logging failure');
    });
    const messages = inputEvents.map(event => message(event));
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
    expect(await work).toMatchObject({ message: 'synthetic logging failure' });
    for (const index of [0, 2]) {
      expect(messages[index].ack).toHaveBeenCalledExactlyOnceWith();
      expect(messages[index].retry).not.toHaveBeenCalled();
    }
    expect(fetch).toHaveBeenCalledTimes(3);
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
