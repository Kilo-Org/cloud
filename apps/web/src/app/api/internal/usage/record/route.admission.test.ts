import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { recordUsage } from '@kilocode/worker-utils/usage-writer-client';
import { saveUsageRelatedDataLocally } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { queueWriterAdmission } from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'synthetic-route-secret',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/processUsage', () => ({
  saveUsageRelatedDataLocally: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0, options: { max: 10 } },
}));
const writerPool = jest.requireMock<{
  pool: { totalCount: number; idleCount: number; waitingCount: number };
}>('@kilocode/web-shared/lib/drizzle').pool;

const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const createdAt = '2026-08-05T10:11:12.945Z';
// The remaining contract fields are nullable; exercise real schema validation without DB fixtures.
const payload = UsageRecordRequestSchema.parse({
  core: {
    ...Object.fromEntries(
      Object.keys(UsageRecordRequestSchema.shape.core.shape).map(key => [key, null])
    ),
    id,
    kilo_user_id: 'oauth/synthetic',
    created_at: createdAt,
    cost: 1234,
    input_tokens: 10,
    output_tokens: 20,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    has_error: false,
    abuse_classification: 0,
  },
  metadata: {
    ...Object.fromEntries(
      Object.keys(UsageRecordRequestSchema.shape.metadata.shape).map(key => [key, null])
    ),
    id,
    message_id: 'synthetic-message',
    created_at: createdAt,
    is_user_byok: false,
    user_prompt_prefix: 'sensitive-prompt',
  },
  prior_microdollar_usage: 42,
  posthog_distinct_id: 'sensitive-posthog-id',
  bouncer_usage_event: {
    request_id: 'sensitive-request-id',
    payload: { secret: 'sensitive-bouncer' },
  },
});
const recorded = {
  usageId: id,
  createdAt: '2026-08-05 10:11:12.945+00',
  newMicrodollarsUsed: 1334,
  wasRedelivery: false,
};
const persist = jest.mocked(saveUsageRelatedDataLocally);

function request(source?: string, secret = 'synthetic-route-secret', body: unknown = payload) {
  return new NextRequest('http://localhost/api/internal/usage/record', {
    method: 'POST',
    headers: {
      'x-internal-api-key': secret,
      ...(source === undefined ? {} : { 'x-usage-write-source': source }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  persist.mockReset().mockResolvedValue(recorded);
  Object.assign(writerPool, { totalCount: 0, idleCount: 0, waitingCount: 0 });
  jest.spyOn(Math, 'random').mockReturnValue(1);
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    jest.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

async function holdWrites(count: number) {
  const started = Promise.withResolvers<void>();
  const pending = Array.from({ length: count }, () =>
    Promise.withResolvers<Awaited<ReturnType<typeof saveUsageRelatedDataLocally>>>()
  );
  pending.forEach((item, index) =>
    persist.mockImplementationOnce(() => {
      if (index === count - 1) started.resolve();
      return item.promise;
    })
  );
  const work = pending.map((_, index) => POST(request(index % 2 ? 'queue_vercel' : 'queue')));
  await started.promise;
  return {
    pending,
    work,
    async drain() {
      pending.forEach(item => item.resolve(recorded));
      await Promise.allSettled(work);
    },
  };
}

it.each(['queue', 'queue_vercel'])(
  'shares eight held slots and rejects the ninth %s without persistence',
  async source => {
    const held = await holdWrites(8);
    try {
      const ninth = await POST(request(source));
      expect(ninth.status).toBe(429);
      await expect(ninth.json()).resolves.toEqual({
        error: 'Usage writer overloaded',
        reason: 'queue_limit',
      });
      expect(persist).toHaveBeenCalledTimes(8);
      // Completing one actual writer promise releases one slot while all peers remain pending.
      held.pending[0].resolve(recorded);
      expect((await held.work[0]).status).toBe(200);
      const replacement = await POST(request(source));
      expect(replacement.status).toBe(200);
      expect(persist).toHaveBeenCalledTimes(9);
    } finally {
      await held.drain();
    }
  }
);

it('keeps auth and validation ahead of admission even when the pool is overloaded', async () => {
  writerPool.waitingCount = 1;
  const acquire = jest.spyOn(queueWriterAdmission, 'tryAcquire');
  const unauthorized = request('queue', 'wrong-secret');
  const json = jest.spyOn(unauthorized, 'json');
  expect((await POST(unauthorized)).status).toBe(401);
  expect(json).not.toHaveBeenCalled();
  expect((await POST(request('queue', 'synthetic-route-secret', {}))).status).toBe(400);
  const malformed = request('queue');
  jest.spyOn(malformed, 'json').mockRejectedValue(new SyntaxError('synthetic invalid JSON'));
  expect((await POST(malformed)).status).toBe(400);
  expect(acquire).not.toHaveBeenCalled();
  expect(persist).not.toHaveBeenCalled();
});

it.each([
  ['queue', { totalCount: 10, idleCount: 2, waitingCount: 0 }, 'pool_busy'],
  ['queue_vercel', { totalCount: 10, idleCount: 0, waitingCount: 1 }, 'pool_waiting'],
] as const)('rejects %s for %s before persistence', async (source, gauges, reason) => {
  Object.assign(writerPool, gauges);
  const response = await POST(request(source));
  expect(response.status).toBe(429);
  await expect(response.json()).resolves.toEqual({ error: 'Usage writer overloaded', reason });
  expect(persist).not.toHaveBeenCalled();
});

it.each([undefined, 'region_handoff', 'unknown', 'QUEUE', 'sensitive-arbitrary-source'])(
  'preserves bypass caller %s under full queue and pool pressure',
  async source => {
    const held = await holdWrites(8);
    try {
      writerPool.waitingCount = 1;
      const acquire = jest.spyOn(queueWriterAdmission, 'tryAcquire');
      const response = await POST(request(source));
      expect(response.status).toBe(200);
      expect(acquire).not.toHaveBeenCalled();
      expect(persist).toHaveBeenLastCalledWith(
        payload.core,
        payload.metadata,
        payload.prior_microdollar_usage,
        payload.posthog_distinct_id,
        payload.bouncer_usage_event,
        {
          entrypoint: 'writer_endpoint',
          writer_caller: source === 'region_handoff' ? source : 'unknown',
        }
      );
    } finally {
      await held.drain();
    }
  }
);

it.each(['recorded', 'duplicate', 'null', 'throw'] as const)(
  'releases the last slot after %s while other writes remain pending',
  async outcome => {
    const held = await holdWrites(7);
    const error = new Error('synthetic original persistence error');
    try {
      if (outcome === 'throw') persist.mockRejectedValueOnce(error);
      else
        persist.mockResolvedValueOnce(
          outcome === 'null' ? null : { ...recorded, wasRedelivery: outcome === 'duplicate' }
        );
      if (outcome === 'throw') await expect(POST(request('queue'))).rejects.toBe(error);
      else {
        const response = await POST(request('queue'));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(
          outcome === 'null'
            ? { status: 'not_recorded', result: null }
            : { status: outcome, result: { usageId: id, createdAt, newMicrodollarsUsed: 1334 } }
        );
      }
      // A leaked slot would reject this request: seven peers are still held.
      expect((await POST(request('queue_vercel'))).status).toBe(200);
      expect(persist).toHaveBeenCalledTimes(9);
    } finally {
      await held.drain();
    }
  }
);

it('composes actual route429 with the queue writer client without acknowledgement or fallback', async () => {
  writerPool.waitingCount = 1;
  const fetchWriter: typeof fetch = async (url, init) =>
    POST(new NextRequest(new Request(url, init)));
  const outcome = await recordUsage(
    payload,
    {
      url: 'http://localhost/api/internal/usage/record',
      secret: 'synthetic-route-secret',
      source: 'queue',
    },
    fetchWriter
  );
  expect(outcome).toEqual({
    kind: 'unavailable',
    reason: 'http_error',
    status: 429,
    admissionReason: 'pool_waiting',
  });
  expect(persist).not.toHaveBeenCalled();
});

it('emits redacted bounded admission diagnostics and preserves writes when logging fails', async () => {
  jest.mocked(Math.random).mockReturnValue(0);
  expect((await POST(request('queue'))).status).toBe(200);
  writerPool.waitingCount = 1;
  expect((await POST(request('queue_vercel'))).status).toBe(429);
  const logs = [console.log, console.info, console.warn, console.error].flatMap(
    log => jest.mocked(log).mock.calls
  );
  const admission = logs
    .map(([line]) => (typeof line === 'string' ? JSON.parse(line) : null))
    .filter(line => line?.event === 'usage_writer_admission');
  expect(admission).toHaveLength(2);
  expect(admission.map(line => line.outcome)).toEqual(['admitted', 'rejected']);
  for (const line of admission)
    expect(Object.keys(line).sort()).toEqual([
      'active',
      'event',
      'limit',
      'outcome',
      'pool',
      'pool_max',
      'reason',
      'sample_rate',
      'writer_caller',
    ]);
  expect(JSON.stringify(admission)).not.toContain('sensitive');
  expect(JSON.stringify(admission)).not.toContain('synthetic-route-secret');
  writerPool.waitingCount = 0;
  jest.mocked(console.info).mockImplementation(() => {
    throw new Error('synthetic logging failure');
  });
  // Suppress unrelated existing timing emission; admission still samples from zero.
  jest.mocked(Math.random).mockReturnValueOnce(0).mockReturnValue(1);
  expect((await POST(request('queue'))).status).toBe(200);
  expect(persist).toHaveBeenCalledTimes(2);
});
