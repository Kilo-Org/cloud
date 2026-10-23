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

  it('preserves logging exceptions without settling failed or later messages', async () => {
    const { fetch, logs } = setup();
    fetch.mockResolvedValue(acknowledgement());
    logs[1].mockImplementation(value => {
      if (String(value).startsWith('{')) throw new Error('synthetic logging failure');
    });
    const messages = [message(), message()];
    await expect(worker.queue(batch(messages), env)).rejects.toThrow('synthetic logging failure');
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const msg of messages) {
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });
});
