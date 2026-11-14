import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageRecordRequestSchema } from '@kilocode/usage-contracts';
import { recordLlmUsage, USAGE_WRITER_TIMEOUT_MS } from './usage-writer-client';

const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const createdAt = '2026-08-05T10:11:12.945Z';
const usage = UsageRecordRequestSchema.parse({
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
  },
  prior_microdollar_usage: 0,
  posthog_distinct_id: null,
  bouncer_usage_event: null,
});
const config = {
  url: 'https://writer.example.test/api/internal/usage/record',
  secret: 'synthetic-writer-secret',
};
const result = { usageId: id, createdAt, newMicrodollarsUsed: 1234 };

function neverResolvingFetch(): typeof fetch {
  return vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error('Expected abort signal');
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
  );
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('recordLlmUsage timeoutMs', () => {
  it('times out a writer that never responds after the configured timeout', async () => {
    const fetchWriter = neverResolvingFetch();
    const startedAt = performance.now();
    expect(await recordLlmUsage(usage, { ...config, timeoutMs: 50 }, fetchWriter)).toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
    expect(performance.now() - startedAt).toBeLessThan(USAGE_WRITER_TIMEOUT_MS);
    expect(fetchWriter).toHaveBeenCalledTimes(1);
  });

  it('defaults to the 160-second writer timeout when timeoutMs is omitted', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchWriter = vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'recorded', result })
    );
    expect(await recordLlmUsage(usage, config, fetchWriter)).toEqual({ kind: 'recorded', result });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(USAGE_WRITER_TIMEOUT_MS);
    expect(USAGE_WRITER_TIMEOUT_MS).toBe(160_000);
  });

  it.each([-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'falls back to the default timeout instead of throwing for timeoutMs %s',
    async timeoutMs => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const fetchWriter = vi.fn<typeof fetch>(async () =>
        Response.json({ status: 'recorded', result })
      );
      expect(await recordLlmUsage(usage, { ...config, timeoutMs }, fetchWriter)).toEqual({
        kind: 'recorded',
        result,
      });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(USAGE_WRITER_TIMEOUT_MS);
    }
  );
});

describe('recordLlmUsage ingress_direct source', () => {
  it('marks the request with the ingress_direct source header', async () => {
    const fetchWriter = vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'duplicate', result })
    );
    expect(
      await recordLlmUsage(
        usage,
        { ...config, source: 'ingress_direct', timeoutMs: 2000 },
        fetchWriter
      )
    ).toEqual({ kind: 'duplicate', result });
    expect(fetchWriter.mock.calls[0]?.[1]?.headers).toEqual({
      'content-type': 'application/json',
      'x-internal-api-key': config.secret,
      'x-usage-write-source': 'ingress_direct',
    });
  });
});
