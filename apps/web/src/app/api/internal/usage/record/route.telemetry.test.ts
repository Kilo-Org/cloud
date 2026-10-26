import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { saveUsageRelatedDataLocally } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'synthetic-route-secret',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/processUsage', () => ({
  saveUsageRelatedDataLocally: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  pool: { totalCount: 1, idleCount: 1, waitingCount: 0, options: { max: 10 } },
}));

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
  jest.spyOn(Math, 'random').mockReturnValue(1);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('usage writer telemetry caller context', () => {
  it.each([
    ['queue', 'queue'],
    ['region_handoff', 'region_handoff'],
    [undefined, 'unknown'],
    ['https://sensitive-invalid-source.example/path?token=secret', 'unknown'],
  ] as const)('maps authenticated source %s to a bounded context', async (source, expected) => {
    // Exercise actual route telemetry so the redaction assertion inspects an emitted event.
    jest.mocked(Math.random).mockReturnValue(0);
    const response = await POST(request(source));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'recorded',
      result: { usageId: id, createdAt, newMicrodollarsUsed: 1334 },
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(
      payload.core,
      payload.metadata,
      payload.prior_microdollar_usage,
      payload.posthog_distinct_id,
      payload.bouncer_usage_event,
      { entrypoint: 'writer_endpoint', writer_caller: expected }
    );
    const logs = [console.log, console.info, console.warn, console.error].flatMap(
      log => jest.mocked(log).mock.calls
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0][0])).toMatchObject({
      type: 'usage_record_timing',
      usage_id: id,
      outcome: 'recorded',
    });
    expect(JSON.stringify(logs)).not.toContain('sensitive');
  });

  it('rejects an unauthenticated caller before body parsing or persistence', async () => {
    const req = request('queue', 'wrong-secret');
    const json = jest.spyOn(req, 'json');
    expect((await POST(req)).status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('preserves validation failure independently of caller classification', async () => {
    expect((await POST(request('queue', 'synthetic-route-secret', {}))).status).toBe(400);
    expect(persist).not.toHaveBeenCalled();
  });

  it.each([true, null])('preserves duplicate/null response semantics (%s)', async duplicate => {
    persist.mockResolvedValue(
      duplicate === null ? null : { ...recorded, wasRedelivery: duplicate }
    );
    const response = await POST(request('region_handoff'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      duplicate === null
        ? { status: 'not_recorded', result: null }
        : {
            status: 'duplicate',
            result: { usageId: id, createdAt, newMicrodollarsUsed: 1334 },
          }
    );
  });

  it('keeps the original persistence exception', async () => {
    const error = new Error('synthetic persistence failure');
    persist.mockRejectedValue(error);
    await expect(POST(request('queue'))).rejects.toBe(error);
  });
});
