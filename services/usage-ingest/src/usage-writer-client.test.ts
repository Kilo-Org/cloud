import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';
import { enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaRecord } from './exa-usage.test-fixture';
import {
  MAX_WRITER_RESPONSE_BYTES,
  recordLlmUsage,
  USAGE_WRITER_TIMEOUT_MS,
  recordEnkryptUsage,
  recordExaUsage,
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
    enkryptRecord.kiloUserId,
    enkryptRecord.sessionId,
    enkryptRecord.organizationId,
    exaRecord.userId,
    exaRecord.organizationId,
    exaRecord.occurredAt,
    exaRecord.featureId,
    exaRecord.type,
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
      expect(await recordLlmUsage(usage, config)).toEqual({
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
    expect(await recordLlmUsage(usage, config)).toEqual({
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
    expect(await recordLlmUsage(usage, config)).toMatchObject({ admissionReason: 'queue_limit' });
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
    expect(await recordLlmUsage(usage, config)).toEqual({
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
    const work = recordLlmUsage(usage, config).then(result => {
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
      expect(await recordLlmUsage(usage, config)).toEqual({
        kind: 'unavailable',
        reason: 'http_error',
        status: 429,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('logs only the error name when an LLM 429 body is malformed', async () => {
    fetchMock.mockResolvedValue(new Response(`{"secret":"${config.secret}"`, { status: 429 }));
    expect(await recordLlmUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 429,
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('usage writer unavailable', {
      usageId: usage.core.id,
      reason: 'http_error',
      status: 429,
      error: 'SyntaxError',
    });
  });

  it('does not parse a503 error body as admission', async () => {
    const response = Response.json(
      { error: 'Usage writer overloaded', reason: 'queue_limit' },
      { status: 503 }
    );
    if (!response.body) throw new Error('Expected body');
    const read = vi.spyOn(response.body, 'getReader');
    fetchMock.mockResolvedValue(response);
    expect(await recordLlmUsage(usage, config)).toEqual({
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
    const outcome = recordLlmUsage(event, config).then(value => {
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
    expect(await recordLlmUsage(usage, { ...config, source: 'queue' })).toEqual({
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
    expect(await recordLlmUsage(usage, { url: config.url, secret: config.secret })).toEqual({
      kind: 'duplicate',
      result: duplicate,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-vercel-protection-bypass');
  });

  it('reports HTTP 200 not_recorded as a failed write, without a client retry', async () => {
    fetchMock.mockResolvedValue(Response.json({ status: 'not_recorded', result: null }));
    expect(await recordLlmUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'not_recorded',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ url: config.url }, { secret: config.secret }])(
    'does no network I/O with missing configuration',
    async incomplete => {
      expect(await recordLlmUsage(usage, incomplete)).toEqual({
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
      expect(await recordLlmUsage(usage, config)).toEqual({
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
    expect(await recordLlmUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('rejects an empty acknowledgement', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await recordLlmUsage(usage, config)).toEqual({
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
    expect(await recordLlmUsage(usage, config)).toEqual({
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
    expect(await recordLlmUsage(usage, config)).toEqual({ kind: 'unavailable', reason: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('contains transport failures and logs only the usage ID, safe outcome and error name', async () => {
    fetchMock.mockRejectedValue(
      new Error(
        `${config.url} ${config.secret} ${config.protectionBypass} ${usage.metadata.user_prompt_prefix}`
      )
    );
    expect(await recordLlmUsage(usage, config)).toEqual({
      kind: 'unavailable',
      reason: 'request_failed',
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('usage writer unavailable', {
      usageId: usage.core.id,
      reason: 'request_failed',
      error: 'Error',
    });
  });
});

describe('Enkrypt usage writer client', () => {
  const enkryptConfig = {
    url: 'https://writer.example.test/api/internal/enkrypt-usage/record',
    secret: config.secret,
    source: 'queue' as const,
  };

  it.each(['recorded', 'duplicate'] as const)(
    'posts the record unchanged and accepts a %s echo of its id',
    async status => {
      fetchMock.mockResolvedValue(Response.json({ status, usageId: enkryptRecord.id }));
      expect(await recordEnkryptUsage(enkryptRecord, enkryptConfig)).toEqual({
        kind: status,
        result: { status, usageId: enkryptRecord.id },
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(enkryptConfig.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': config.secret,
          'x-usage-write-source': 'queue',
        },
        body: JSON.stringify(enkryptRecord),
        signal: expect.any(AbortSignal),
      });
      expect(console.info).toHaveBeenCalledExactlyOnceWith('usage writer acknowledged', {
        usageId: enkryptRecord.id,
        usageKind: 'enkrypt_usage',
        outcome: status,
      });
    }
  );

  it.each([
    ['another usage id', { status: 'recorded', usageId: '7b2d3f4a-5c6e-4f7a-9b8c-0d1e2f3a4b5c' }],
    ['a missing usage id', { status: 'duplicate' }],
    ['an LLM acknowledgement', { status: 'recorded', result: { usageId: enkryptRecord.id } }],
    ['not_recorded', { status: 'not_recorded', usageId: enkryptRecord.id }],
    ['an extra key', { status: 'recorded', usageId: enkryptRecord.id, extra: true }],
  ])('rejects %s as an invalid response', async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await recordEnkryptUsage(enkryptRecord, enkryptConfig)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('usage writer unavailable', {
      usageId: enkryptRecord.id,
      usageKind: 'enkrypt_usage',
      reason: 'invalid_response',
    });
  });

  it('reuses the bounded admission 429 parsing', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Usage writer overloaded', reason: 'pool_busy' }, { status: 429 })
    );
    expect(await recordEnkryptUsage(enkryptRecord, enkryptConfig)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 429,
      admissionReason: 'pool_busy',
    });
  });

  it('keeps an unreadable 429 body a generic overload and logs only the error name', async () => {
    fetchMock.mockResolvedValue(new Response(`{"secret":"${config.secret}"`, { status: 429 }));
    expect(await recordEnkryptUsage(enkryptRecord, enkryptConfig)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 429,
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('usage writer unavailable', {
      usageId: enkryptRecord.id,
      usageKind: 'enkrypt_usage',
      reason: 'http_error',
      status: 429,
      error: 'SyntaxError',
    });
  });

  it('does no network I/O without a writer URL', async () => {
    expect(await recordEnkryptUsage(enkryptRecord, { secret: config.secret })).toEqual({
      kind: 'unavailable',
      reason: 'missing_config',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out with the shared writer timeout', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      expect(ms).toBe(USAGE_WRITER_TIMEOUT_MS);
      return timeout(5);
    });
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) throw new Error('Expected abort signal');
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })
    );
    expect(await recordEnkryptUsage(enkryptRecord, enkryptConfig)).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
  });
});

describe('Exa usage writer client', () => {
  const exaConfig = {
    url: 'https://writer.example.test/api/internal/exa-usage/record',
    secret: config.secret,
    source: 'queue' as const,
  };

  it.each(['recorded', 'duplicate'] as const)(
    'posts the record unchanged and accepts a %s echo of its id',
    async status => {
      fetchMock.mockResolvedValue(Response.json({ status, usageId: exaRecord.id }));
      expect(await recordExaUsage(exaRecord, exaConfig)).toEqual({
        kind: status,
        result: { status, usageId: exaRecord.id },
      });
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(exaConfig.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-internal-api-key': config.secret,
          'x-usage-write-source': 'queue',
        },
        body: JSON.stringify(exaRecord),
        signal: expect.any(AbortSignal),
      });
      expect(console.info).toHaveBeenCalledExactlyOnceWith('usage writer acknowledged', {
        usageId: exaRecord.id,
        usageKind: 'exa_usage',
        outcome: status,
      });
    }
  );

  it.each([
    ['another usage id', { status: 'recorded', usageId: '7b2d3f4a-5c6e-4f7a-9b8c-0d1e2f3a4b5c' }],
    ['a missing usage id', { status: 'duplicate' }],
    ['an LLM acknowledgement', { status: 'recorded', result: { usageId: exaRecord.id } }],
    ['not_recorded', { status: 'not_recorded', usageId: exaRecord.id }],
    ['an extra key', { status: 'recorded', usageId: exaRecord.id, extra: true }],
  ])('rejects %s as an invalid response', async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    expect(await recordExaUsage(exaRecord, exaConfig)).toEqual({
      kind: 'unavailable',
      reason: 'invalid_response',
    });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('usage writer unavailable', {
      usageId: exaRecord.id,
      usageKind: 'exa_usage',
      reason: 'invalid_response',
    });
  });

  it('reuses the bounded admission 429 parsing', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'Usage writer overloaded', reason: 'queue_limit' }, { status: 429 })
    );
    expect(await recordExaUsage(exaRecord, exaConfig)).toEqual({
      kind: 'unavailable',
      reason: 'http_error',
      status: 429,
      admissionReason: 'queue_limit',
    });
  });

  it('does no network I/O without a writer URL', async () => {
    expect(await recordExaUsage(exaRecord, { secret: config.secret })).toEqual({
      kind: 'unavailable',
      reason: 'missing_config',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('unread response release', () => {
  it.each([
    ['a truncated 429 rejection', 429],
    ['a truncated acknowledgement', 200],
  ])('does not report a release failure after %s errored the read body', async (_label, status) => {
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"status":'));
            controller.error(new TypeError('synthetic body failure'));
          },
        }),
        { status }
      )
    );
    await recordLlmUsage(usage, config);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(console.warn).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalledWith(
      'usage writer response release failed',
      expect.anything()
    );
  });

  it.each([
    ['LLM', () => recordLlmUsage(usage, config), { usageId: usage.core.id }],
    [
      'Enkrypt',
      () =>
        recordEnkryptUsage(enkryptRecord, {
          ...config,
          url: 'https://writer.example.test/api/internal/enkrypt-usage/record',
        }),
      { usageId: enkryptRecord.id, usageKind: 'enkrypt_usage' },
    ],
    [
      'Exa',
      () =>
        recordExaUsage(exaRecord, {
          ...config,
          url: 'https://writer.example.test/api/internal/exa-usage/record',
        }),
      { usageId: exaRecord.id, usageKind: 'exa_usage' },
    ],
  ])(
    'logs only the error name when releasing a %s error body fails and keeps the outcome',
    async (_label, write, identity) => {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          throw new TypeError(`release failed ${config.secret}`);
        },
      });
      fetchMock.mockResolvedValue(new Response(body, { status: 503 }));
      expect(await write()).toEqual({ kind: 'unavailable', reason: 'http_error', status: 503 });
      await vi.waitFor(() =>
        expect(console.warn).toHaveBeenCalledWith('usage writer response release failed', {
          ...identity,
          error: 'TypeError',
        })
      );
    }
  );
});
