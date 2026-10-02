import { describe, expect, it } from '@jest/globals';
import { getModelTraffic, type RunAnalyticsEngineQuery } from '@/lib/ai-gateway/model-traffic';

const NOW = new Date('2026-10-02T12:03:20Z');
const LAST_BUCKET = '2026-10-02 11:55:00';
const FIRST_BUCKET = '2026-10-01 12:00:00';

function fakeQuery(responses: {
  totals: unknown[];
  topModels: unknown[];
  modelBuckets: unknown[];
}): { runQuery: RunAnalyticsEngineQuery; queries: string[] } {
  const queries: string[] = [];
  const runQuery: RunAnalyticsEngineQuery = async sql => {
    queries.push(sql);
    if (sql.includes('GROUP BY bucket, model')) return responses.modelBuckets;
    if (sql.includes('GROUP BY model')) return responses.topModels;
    return responses.totals;
  };
  return { runQuery, queries };
}

describe('getModelTraffic', () => {
  it('returns 288 completed five-minute buckets ending before the in-progress bucket', async () => {
    const { runQuery, queries } = fakeQuery({ totals: [], topModels: [], modelBuckets: [] });

    const traffic = await getModelTraffic({ now: NOW, excludeByok: false }, runQuery);

    expect(traffic.bucketStarts).toHaveLength(288);
    expect(traffic.bucketStarts[0]).toBe('2026-10-01T12:00:00.000Z');
    expect(traffic.bucketStarts.at(-1)).toBe('2026-10-02T11:55:00.000Z');
    expect(traffic.models).toEqual([]);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain(
      `timestamp >= toDateTime(${Date.parse('2026-10-01T12:00:00Z') / 1000})`
    );
    expect(queries[0]).toContain(
      `timestamp < toDateTime(${Date.parse('2026-10-02T12:00:00Z') / 1000})`
    );
    expect(queries[0]).not.toContain('blob6');
  });

  it('places top-model series into buckets and derives the remainder as other models', async () => {
    const { runQuery, queries } = fakeQuery({
      totals: [
        { bucket: FIRST_BUCKET, requests: '100', errors: '10' },
        { bucket: LAST_BUCKET, requests: 50, errors: 0 },
      ],
      topModels: [
        { model: 'anthropic/claude-opus-5.5', requests: '120' },
        { model: "vendor/o'model", requests: '20' },
      ],
      modelBuckets: [
        { bucket: FIRST_BUCKET, model: 'anthropic/claude-opus-5.5', requests: '70', errors: '7' },
        { bucket: LAST_BUCKET, model: 'anthropic/claude-opus-5.5', requests: '50', errors: '0' },
        { bucket: FIRST_BUCKET, model: "vendor/o'model", requests: '20', errors: '1' },
        { bucket: '2026-10-02 12:00:00', model: "vendor/o'model", requests: '5', errors: '5' },
      ],
    });

    const traffic = await getModelTraffic({ now: NOW, excludeByok: true }, runQuery);

    const [opus, other] = traffic.models;
    expect(opus.model).toBe('anthropic/claude-opus-5.5');
    expect(opus.totalRequests).toBe(120);
    expect(opus.requests[0]).toBe(70);
    expect(opus.errors[0]).toBe(7);
    expect(opus.requests.at(-1)).toBe(50);
    expect(other.requests.reduce((sum, value) => sum + value, 0)).toBe(20);

    expect(traffic.allModels.requests[0]).toBe(100);
    expect(traffic.otherModels.requests[0]).toBe(10);
    expect(traffic.otherModels.errors[0]).toBe(2);
    expect(traffic.otherModels.requests.at(-1)).toBe(0);

    expect(queries).toHaveLength(3);
    for (const sql of queries) expect(sql).toContain("blob6 = '0'");
    expect(queries[2]).toContain("blob2 IN ('anthropic/claude-opus-5.5', 'vendor/o''model')");
  });
});
