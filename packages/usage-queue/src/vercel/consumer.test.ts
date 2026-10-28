import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { MessageMetadata } from '@vercel/queue';
import { consumeVercelUsage } from './consumer';
import { payload } from './fixture';
import { signUsageMessage } from './message';

const metadata: MessageMetadata = {
  messageId: 'synthetic-message',
  deliveryCount: 2,
  createdAt: new Date(Date.now() - 1200),
  expiresAt: new Date(Date.now() + 86400000),
  topicName: 'usage-staging',
  consumerGroup: 'usage',
  region: 'fra1',
};
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  Object.assign(process.env, {
    VERCEL_TARGET_ENV: 'staging',
    VERCEL_ENV: 'preview',
    VERCEL_REGION: 'fra1',
    USAGE_WRITER_URL: 'https://writer.test/api/internal/usage/record',
    USAGE_WRITER_SECRET: 'SECRET',
    USAGE_WRITER_PROTECTION_BYPASS: 'BYPASS',
  });
  globalThis.fetch = fetchMock;
  fetchMock.mockReset();
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  const logs = JSON.stringify([
    ...vi.mocked(console.info).mock.calls,
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
  ]);
  for (const secret of ['SECRET', 'BYPASS', payload.metadata.user_prompt_prefix]) {
    if (secret) expect(logs).not.toContain(secret);
  }
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function response(status: string, usageId = payload.core.id) {
  return Response.json({
    status,
    result:
      status === 'not_recorded'
        ? null
        : { usageId, createdAt: payload.core.created_at, newMicrodollarsUsed: 1234 },
  });
}

test.each(['recorded', 'duplicate'])('returns only for matching writer %s', async status => {
  fetchMock.mockResolvedValue(response(status));
  await expect(
    consumeVercelUsage(await signUsageMessage(payload, 'SECRET'), metadata)
  ).resolves.toBeUndefined();
  expect(fetchMock).toHaveBeenCalledWith(
    process.env.USAGE_WRITER_URL,
    expect.objectContaining({
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': 'SECRET',
        'x-vercel-protection-bypass': 'BYPASS',
        'x-usage-write-source': 'queue_vercel',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
    })
  );
  expect(console.info).toHaveBeenCalledWith(
    'usage queue consumer completed',
    expect.objectContaining({
      usageId: payload.core.id,
      outcome: status,
      delivery_attempt: 2,
      queue_region: 'fra1',
      execution_region: 'fra1',
      queue_age_ms: expect.any(Number),
      writer_http_duration_ms: expect.any(Number),
    })
  );
});

test.each([
  'not_recorded',
  'wrong_id',
  'malformed',
  'unreadable',
  '429',
  '503',
  'timeout',
  'network',
  'missing_config',
])('throws for %s so callback cannot ack', async failure => {
  if (failure === 'missing_config') delete process.env.USAGE_WRITER_URL;
  else if (failure === 'timeout' || failure === 'network') {
    if (failure === 'timeout') {
      const controller = new AbortController();
      controller.abort();
      vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    }
    fetchMock.mockRejectedValue(new Error('SECRET'));
  } else if (failure === 'malformed')
    fetchMock.mockResolvedValue(Response.json({ secret: 'SECRET' }));
  else if (failure === 'unreadable') fetchMock.mockResolvedValue(new Response('SECRET'));
  else if (failure === '429' || failure === '503')
    fetchMock.mockResolvedValue(new Response('SECRET', { status: Number(failure) }));
  else
    fetchMock.mockResolvedValue(
      response(
        failure === 'not_recorded' ? failure : 'recorded',
        failure === 'wrong_id' ? 'wrong-id' : payload.core.id
      )
    );
  await expect(
    consumeVercelUsage(await signUsageMessage(payload, 'SECRET'), metadata)
  ).rejects.toThrow('usage writer unavailable');
  if (failure === 'timeout') {
    expect(console.warn).toHaveBeenCalledWith(
      'usage queue consumer failed',
      expect.objectContaining({ reason: 'timeout' })
    );
  }
  expect(console.info).not.toHaveBeenCalledWith(
    'usage queue consumer completed',
    expect.anything()
  );
});

test('invalid payload is observable and retried without writer I/O', async () => {
  await expect(
    consumeVercelUsage(await signUsageMessage({ secret: 'SECRET' }, 'SECRET'), metadata)
  ).rejects.toThrow('invalid usage queue payload');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(console.error).toHaveBeenCalledWith(
    'usage queue consumer failed',
    expect.objectContaining({ reason: 'invalid_payload' })
  );
});

test('authenticates original wire data before applying additive schema defaults', async () => {
  const legacy = {
    ...payload,
    metadata: Object.fromEntries(
      Object.entries(payload.metadata).filter(([key]) => key !== 'non_inference_cost')
    ),
  };
  fetchMock.mockResolvedValue(response('recorded'));
  await expect(
    consumeVercelUsage(await signUsageMessage(legacy, 'SECRET'), metadata)
  ).resolves.toBeUndefined();
  expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify(payload));
});

test('consumer refuses production even with a staging target', async () => {
  process.env.VERCEL_ENV = 'production';
  await expect(
    consumeVercelUsage(await signUsageMessage(payload, 'SECRET'), metadata)
  ).rejects.toThrow('requires staging');
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each(['unsigned', 'tampered', 'wrong_secret', 'missing_secret', 'wrong_topic'])(
  'rejects %s authentication failure before any writer I/O',
  async failure => {
    const signed = await signUsageMessage(
      payload,
      failure === 'wrong_secret' ? 'other-secret' : 'SECRET'
    );
    const message =
      failure === 'unsigned'
        ? payload
        : failure === 'tampered'
          ? {
              ...signed,
              payload: { ...payload, core: { ...payload.core, cost: payload.core.cost + 1 } },
            }
          : signed;
    if (failure === 'missing_secret') delete process.env.USAGE_WRITER_SECRET;
    await expect(
      consumeVercelUsage(message, {
        ...metadata,
        topicName: failure === 'wrong_topic' ? 'other-topic' : metadata.topicName,
      })
    ).rejects.toThrow('unauthenticated usage queue message');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      'usage queue consumer failed',
      expect.objectContaining({ reason: 'unauthenticated_message' })
    );
  }
);
