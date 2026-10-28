import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { QueueClient } from '@vercel/queue';
import { consumeVercelUsage } from './consumer';
import { payload } from './fixture';
import { signUsageMessage } from './message';
import { POST } from './callback';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  Object.assign(process.env, {
    VERCEL_TARGET_ENV: 'staging',
    VERCEL_ENV: 'preview',
    VERCEL_REGION: 'fra1',
    USAGE_WRITER_URL: 'https://writer.test/api/internal/usage/record',
    USAGE_WRITER_SECRET: 'synthetic-secret',
    VERCEL_QUEUE_DEBUG: '0',
  });
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Exercise the installed SDK's CloudEvent parser and auto-ack, using synthetic
// credentials and intercepted HTTP. This does not establish hosted delivery.
test.each(['recorded', 'duplicate', 'not_recorded', 'invalid_payload', '503'])(
  'real SDK only sends an ack after writer %s',
  async outcome => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 200 });
      if (outcome === '503') return new Response(null, { status: 503 });
      return Response.json({
        status: outcome,
        result:
          outcome === 'not_recorded'
            ? null
            : {
                usageId: payload.core.id,
                createdAt: payload.core.created_at,
                newMicrodollarsUsed: 1234,
              },
      });
    });
    const client = new QueueClient({
      region: 'fra1',
      token: 'synthetic-token',
      deploymentId: 'dpl_synthetic',
      resolveBaseUrl: () => new URL('https://queue.test'),
    });
    const handler = client.handleCallback(consumeVercelUsage, { visibilityTimeoutSeconds: 300 });
    const response = await handler(
      new Request('https://callback.test', {
        method: 'POST',
        headers: {
          'ce-type': 'com.vercel.queue.v2beta',
          'content-type': 'application/json',
          'ce-vqsqueuename': 'usage-staging',
          'ce-vqsconsumergroup': 'usage',
          'ce-vqsmessageid': 'synthetic-message',
          'ce-vqsreceipthandle': 'synthetic-receipt',
          'ce-vqsregion': 'fra1',
          'ce-vqsdeliverycount': '2',
          'ce-vqscreatedat': new Date().toISOString(),
        },
        body: JSON.stringify(
          await signUsageMessage(outcome === 'invalid_payload' ? {} : payload, 'synthetic-secret')
        ),
      })
    );
    const acknowledged = outcome === 'recorded' || outcome === 'duplicate';
    expect(response.status).toBe(acknowledged ? 200 : 500);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(
      acknowledged ? 1 : 0
    );
    expect(
      fetchMock.mock.calls.every(
        ([url]) =>
          requestUrl(url).startsWith('https://writer.test/') ||
          requestUrl(url).startsWith('https://queue.test/')
      )
    ).toBe(true);
  }
);

test.each(['unsigned', 'tampered', 'wrong_secret', 'wrong_topic'])(
  'forged CloudEvent (%s) cannot write or ack',
  async failure => {
    const signed = await signUsageMessage(
      payload,
      failure === 'wrong_secret' ? 'other-secret' : 'synthetic-secret'
    );
    const forged =
      failure === 'unsigned'
        ? payload
        : failure === 'tampered'
          ? {
              ...signed,
              payload: { ...payload, core: { ...payload.core, cost: payload.core.cost + 1 } },
            }
          : signed;
    fetchMock.mockImplementation(async (_url, init) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 200 })
        : Response.json({
            status: 'recorded',
            result: {
              usageId: payload.core.id,
              createdAt: payload.core.created_at,
              newMicrodollarsUsed: 1234,
            },
          })
    );
    const client = new QueueClient({
      region: 'fra1',
      token: 'synthetic-token',
      deploymentId: 'dpl_synthetic',
      resolveBaseUrl: () => new URL('https://queue.test'),
    });
    const handler = failure === 'unsigned' ? POST : client.handleCallback(consumeVercelUsage);
    const response = await handler(
      new Request('https://callback.test', {
        method: 'POST',
        headers: {
          'ce-type': 'com.vercel.queue.v2beta',
          'content-type': 'application/json',
          'ce-vqsqueuename': failure === 'wrong_topic' ? 'other-topic' : 'usage-staging',
          'ce-vqsconsumergroup': 'usage',
          'ce-vqsmessageid': 'forged-message',
          'ce-vqsreceipthandle': 'forged-receipt',
          'ce-vqsregion': 'fra1',
        },
        body: JSON.stringify(forged),
      })
    );
    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'usage queue consumer failed',
      expect.objectContaining({ reason: 'unauthenticated_message' })
    );
  }
);

// Lease renewal is reached during supported slow writes. Assert logging at the
// SDK boundary as well as continued renewal and the consumer's ACK decision.
test.each(
  [200, 503, 400, 'network'].flatMap(renewal =>
    [true, false].map(recorded => ({ renewal, recorded }))
  )
)(
  'slow writer: renewal=$renewal recorded=$recorded preserves private lease and ACK semantics',
  async ({ renewal, recorded }) => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<Response>();
    const receipt = 'SYNTHETIC_PRIVATE_RECEIPT';
    const rawError = 'SYNTHETIC_PRIVATE_ERROR';
    let patches = 0;
    fetchMock.mockImplementation(async (url, init) => {
      if (requestUrl(url).startsWith('https://writer.test')) return pending.promise;
      if (init?.method === 'PATCH') {
        patches++;
        expect(requestUrl(url)).toContain(receipt);
        if (patches === 1 && renewal === 'network') throw new TypeError(rawError);
        if (patches === 1 && typeof renewal === 'number' && renewal !== 200) {
          return Response.json({ error: rawError }, { status: renewal });
        }
      }
      return new Response(null, { status: 200 });
    });
    const client = new QueueClient({
      region: 'fra1',
      token: 'synthetic-token',
      deploymentId: 'dpl_synthetic',
      resolveBaseUrl: () => new URL('https://queue.test'),
    });
    const handler = client.handleCallback(consumeVercelUsage, { visibilityTimeoutSeconds: 300 });
    const result = handler(
      new Request('https://callback.test', {
        method: 'POST',
        headers: {
          'ce-type': 'com.vercel.queue.v2beta',
          'content-type': 'application/json',
          'ce-vqsqueuename': 'usage-staging',
          'ce-vqsconsumergroup': 'usage',
          'ce-vqsmessageid': 'synthetic-message',
          'ce-vqsreceipthandle': receipt,
          'ce-vqsregion': 'fra1',
          'ce-vqsdeliverycount': '2',
          'ce-vqscreatedat': new Date().toISOString(),
        },
        body: JSON.stringify(await signUsageMessage(payload, 'synthetic-secret')),
      })
    );
    await vi.advanceTimersByTimeAsync(60001);
    expect(patches).toBe(1);
    const transient = renewal === 503 || renewal === 'network';
    await vi.advanceTimersByTimeAsync(3000);
    expect(patches).toBe(transient ? 2 : 1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(patches).toBe(renewal === 400 ? 1 : transient ? 3 : 2);
    pending.resolve(
      Response.json({
        status: recorded ? 'recorded' : 'not_recorded',
        result: recorded
          ? {
              usageId: payload.core.id,
              createdAt: payload.core.created_at,
              newMicrodollarsUsed: 1234,
            }
          : null,
      })
    );
    expect((await result).status).toBe(recorded ? 200 : 500);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(
      recorded ? 1 : 0
    );
    expect(vi.getTimerCount()).toBe(0);
    const logs = [
      ...vi.mocked(console.info).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls,
    ];
    const serialized = JSON.stringify(logs, (_key, value) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
    );
    for (const secret of [receipt, rawError, 'synthetic-token', 'synthetic-secret'])
      expect(serialized).not.toContain(secret);
    if (renewal !== 200)
      expect(console.error).toHaveBeenCalledWith('Queue visibility extension failed', {
        messageId: 'synthetic-message',
        reason: renewal === 400 ? 'client_error' : 'transient_error',
      });
  }
);
