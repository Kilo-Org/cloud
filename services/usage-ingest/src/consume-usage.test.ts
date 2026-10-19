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
  return { fetch, logs };
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
    const { fetch } = setup();
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const secondEvent = {
      ...usage,
      core: { ...usage.core, id: '4f2504e0-4f89-11d3-9a0c-0305e82c3302' },
      bouncer_usage_event: { request_id: 'request-2', payload: { spend: 1234 } },
    };
    const messages = [message({ ...usage, extra: 'strip-me' }), message(secondEvent)];
    const work = worker.queue(batch(messages), env);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(messages[1].ack).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual(usage);
    first.resolve(acknowledgement());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(messages[0].ack).toHaveBeenCalledExactlyOnceWith();
    expect(messages[1].ack).not.toHaveBeenCalled();
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual(secondEvent);
    second.resolve(acknowledgement('duplicate', secondEvent.core.id));
    await work;
    expect(messages[1].ack).toHaveBeenCalledExactlyOnceWith();
    expect(messages.every(msg => msg.retry.mock.calls.length === 0)).toBe(true);
    expect(fetch.mock.calls[0][1]?.headers).toEqual({
      'content-type': 'application/json',
      'x-internal-api-key': writerSecret,
      'x-vercel-protection-bypass': env.USAGE_WRITER_PROTECTION_BYPASS,
    });
  });

  it.each(['', 'unexpected'])('retries unknown mode %s without network or ACK', async mode => {
    const { fetch, logs } = setup();
    const msg = message();
    await worker.queue(batch([msg]), { ...env, USAGE_INGEST_MODE: mode });
    expect(msg.ack).not.toHaveBeenCalled();
    expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(logs[0].mock.calls[0][0])).reason).toBe('invalid_mode');
  });

  it.each(['invalid', 'missing_url', 'missing_secret'])(
    'retries %s without a writer call',
    async failure => {
      const { fetch, logs } = setup();
      const msg = message(failure === 'invalid' ? { core: { id: 'sensitive-invalid-id' } } : usage);
      await worker.queue(batch([msg]), {
        ...env,
        ...(failure === 'missing_url' ? { USAGE_WRITER_URL: undefined } : {}),
        ...(failure === 'missing_secret' ? { USAGE_WRITER_SECRET: undefined } : {}),
      });
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(
        'sensitive-invalid-id'
      );
    }
  );

  it.each(['not_recorded', 'mismatched', 'malformed', 'unavailable', 'transport', 'timeout'])(
    'retries %s and logs only safe outcomes',
    async failure => {
      const { fetch, logs } = setup();
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
                : new Response('sensitive-response', { status: 503 })
        );
      const msg = message({
        ...usage,
        metadata: { ...usage.metadata, user_prompt_prefix: 'sensitive-prompt' },
      });
      await worker.queue(batch([msg]), env);
      expect(msg.ack).not.toHaveBeenCalled();
      expect(msg.retry).toHaveBeenCalledExactlyOnceWith();
      expect(fetch).toHaveBeenCalledTimes(1);
      const processing = JSON.parse(String(logs[0].mock.calls[0][0]));
      expect(processing).toEqual({
        event: 'usage_ingest_processing',
        outcome: 'unavailable',
        reason: expect.any(String),
        usage_id: usage.core.id,
        queue_message_id: msg.id,
        delivery_attempts: 1,
      });
      const serialized = JSON.stringify(logs.flatMap(log => log.mock.calls));
      for (const sensitive of [
        writerSecret,
        env.USAGE_WRITER_PROTECTION_BYPASS,
        env.USAGE_WRITER_URL,
        'sensitive-exception',
        'sensitive-response',
        'sensitive-prompt',
      ])
        expect(serialized).not.toContain(sensitive);
    }
  );
});
