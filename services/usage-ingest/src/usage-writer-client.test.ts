import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';
import {
  MAX_WRITER_RESPONSE_BYTES,
  recordUsage,
  USAGE_WRITER_TIMEOUT_MS,
} from '@kilocode/worker-utils/usage-writer-client';

const config = {
  url: 'https://writer.example.test/api/internal/usage/record',
  secret: 'synthetic-writer-secret',
  protectionBypass: 'synthetic-vercel-bypass',
};
const result = {
  usageId: usage.core.id,
  createdAt: usage.core.created_at,
  newMicrodollarsUsed: 1234,
};
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  const logs = JSON.stringify([
    vi.mocked(console.warn).mock.calls,
    vi.mocked(console.info).mock.calls,
  ]);
  for (const sensitive of [
    config.url,
    config.secret,
    config.protectionBypass,
    usage.metadata.user_prompt_prefix,
  ]) {
    if (sensitive) expect(logs).not.toContain(sensitive);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('usage writer client', () => {
  it.each(['queue_limit', 'pool_waiting', 'pool_busy'] as const)(
    'recognizes only a complete bounded admission rejection (%s)',
    async reason => {
      fetchMock.mockResolvedValue(
        Response.json({ error: 'Usage writer overloaded', reason }, { status: 429 })
      );
      expect(await recordUsage(usage, config)).toEqual({
        kind: 'unavailable',
        reason: 'http_error',
        status: 429,
        admissionReason: reason,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    JSON.stringify({ error: 'Other overload', reason: 'queue_limit' }),
    JSON.stringify({ error: 'Usage writer overloaded', reason: 'unknown' }),
    JSON.stringify({
      error: 'Usage writer overloaded',
      reason: 'pool_busy',
      secret: 'synthetic-writer-secret',
    }),
    JSON.stringify({ reason: 'pool_waiting' }),
    'null',
    '[1]',
    '{',
    '<html>synthetic-writer-secret</html>',
    new Uint8Array([0xff]),
  ])('preserves generic429 for invalid admission bytes %s', async body => {
    fetchMock.mockResolvedValue(new Response(body, { status: 429 }));
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts4096 bytes, rejects4097 bytes and cancels the oversized stream', async () => {
    const json = JSON.stringify({ error: 'Usage writer overloaded', reason: 'queue_limit' });
    fetchMock.mockResolvedValueOnce(
      new Response(json.padEnd(MAX_WRITER_RESPONSE_BYTES, ' '), { status: 429 })
    );
    expect(await recordUsage(usage, config)).toMatchObject({ admissionReason: 'queue_limit' });
    const cancel = vi.fn();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(json.padEnd(MAX_WRITER_RESPONSE_BYTES + 1, ' '))
            );
          },
          cancel,
        }),
        { status: 429 }
      )
    );
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 429,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not classify a partial rejection until its body closes', async () => {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    fetchMock.mockResolvedValue(new Response(stream.readable, { status: 429 }));
    let complete = false;
    const work = recordUsage(usage, config).then(result => {
      complete = true;
      return result;
    });
    await writer.write(new TextEncoder().encode('{"error":"Usage writer overloaded",'));
    expect(complete).toBe(false);
    await writer.write(new TextEncoder().encode('"reason":"pool_waiting"}'));
    expect(complete).toBe(false);
    await writer.close();
    expect(await work).toMatchObject({ status: 429, admissionReason: 'pool_waiting' });
  });

  it.each(['abort', 'truncate'] as const)(
    'keeps HTTP429 feedback after a slow/%s body fails',
    async failure => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        expect(ms).toBe(160_000);
        return timeout(5);
      });
      fetchMock.mockImplementation(async (_url, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error('Expected signal');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"error":"Usage writer overloaded",'));
              if (failure === 'truncate')
                controller.error(new Error('synthetic private body failure'));
              else
                signal.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true,
                });
            },
          }),
          { status: 429 }
        );
      });
      expect(await recordUsage(usage, config)).toEqual({
        kind: 'unavailable',
        reason: 'http_error',
        status: 429,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('does not parse a503 error body as admission', async () => {
    const response = Response.json(
      { error: 'Usage writer overloaded', reason: 'queue_limit' },
      { status: 503 }
    );
    if (!response.body) throw new Error('Expected body');
    const read = vi.spyOn(response.body, 'getReader');
    fetchMock.mockResolvedValue(response);
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 503,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('preserves the complete event and waits for a matching recorded acknowledgement', async () => {
    const event = {
      ...usage,
      bouncer_usage_event: { request_id: 'synthetic-request', payload: { amount: 1234 } },
    };
    const pending = Promise.withResolvers<Response>();
    fetchMock.mockReturnValue(pending.promise);
    let completed = false;
    const outcome = recordUsage(event, config).then(value => {
      completed = true;
      return value;
    });
    expect(completed).toBe(false);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(config.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': config.secret,
        'x-vercel-protection-bypass': config.protectionBypass,
      },
      body: JSON.stringify(event),
      signal: expect.any(AbortSignal),
    });
    pending.resolve(Response.json({ status: 'recorded', result }));
    expect(await outcome).toEqual({ kind: 'recorded', result });
  });

  it('marks explicitly queued requests without changing the event or acknowledgement', async () => {
    fetchMock.mockResolvedValue(Response.json({ status: 'recorded', result }));
    expect(await recordUsage(usage, { ...config, source: 'queue' })).toEqual({
      kind: 'recorded',
      result,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(config.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': config.secret,
        'x-usage-write-source': 'queue',
        'x-vercel-protection-bypass': config.protectionBypass,
      },
      body: JSON.stringify(usage),
      signal: expect.any(AbortSignal),
    });
  });

  it('accepts a matching duplicate without requiring a new balance update', async () => {
    const duplicate = { ...result, newMicrodollarsUsed: null };
    fetchMock.mockResolvedValue(Response.json({ status: 'duplicate', result: duplicate }));
    expect(await recordUsage(usage, { url: config.url, secret: config.secret })).toEqual({
      kind: 'duplicate',
      result: duplicate,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-vercel-protection-bypass');
  });

  it('reports HTTP 200 not_recorded as a failed write, without a client retry', async () => {
    fetchMock.mockResolvedValue(Response.json({ status: 'not_recorded', result: null }));
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'not_recorded',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ url: config.url }, { secret: config.secret }])(
    'does no network I/O with missing configuration',
    async incomplete => {
      expect(await recordUsage(usage, incomplete)).toEqual({
        kind: 'unavailable',
        reason: 'missing_config',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([401, 302])(
    'rejects HTTP %s, including redirects, without following or retrying',
    async status => {
      fetchMock.mockResolvedValue(new Response('synthetic error', { status }));
      expect(await recordUsage(usage, config)).toEqual({
        kind: 'unavailable',
        reason: 'http_error',
        status,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    }
  );

  it.each([
    '{',
    new Uint8Array([0xff]),
    JSON.stringify({ status: 'recorded', result: null }),
    JSON.stringify({ status: 'recorded', result: { ...result, usageId: 'another-usage-id' } }),
    JSON.stringify({ status: 'unknown', result }),
  ])('rejects an invalid or mismatched acknowledgement', async body => {
    fetchMock.mockResolvedValue(new Response(body));
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('rejects an empty acknowledgement', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('bounds actual response bytes even when Content-Length understates the body', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_WRITER_RESPONSE_BYTES + 1));
        },
        cancel,
      }),
      { headers: { 'content-length': '1' } }
    );
    fetchMock.mockResolvedValue(response);
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['request', 'body'])('times out while waiting for the %s', async phase => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(ms).toBe(USAGE_WRITER_TIMEOUT_MS);
      return timeout(5);
    });
    fetchMock.mockImplementation(async (_url, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error('Expected abort signal');
      if (phase === 'request') {
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        );
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        })
      );
    });
    expect(await recordUsage(usage, config)).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('contains transport failures and logs only the usage ID and safe outcome', async () => {
    fetchMock.mockRejectedValue(
      new Error(
        `${config.url} ${config.secret} ${config.protectionBypass} ${usage.metadata.user_prompt_prefix}`
      )
    );
    expect(await recordUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'request_failed',
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('usage writer unavailable', {
      usageId: usage.core.id,
      reason: 'request_failed',
    });
  });
});
