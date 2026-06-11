import { describe, expect, it } from 'vitest';
import type { CaseResultRow } from './db';
import { runCasesWithConcurrency, summarize } from './run';

function makeRow(overrides: Partial<CaseResultRow> = {}): CaseResultRow {
  return {
    run_id: 'run-1',
    model: 'model/a',
    case_id: 'case-1',
    tier: null,
    score: 1,
    latency_ms: 100,
    cost_usd: 0.001,
    detail_json: null,
    error: null,
    ...overrides,
  };
}

describe('summarize — classifier kind', () => {
  it('groups all classifier rows under * tier', () => {
    const rows: CaseResultRow[] = [
      makeRow({
        model: 'model/a',
        case_id: 'c1',
        tier: null,
        score: 1,
        latency_ms: 100,
        cost_usd: 0.001,
      }),
      makeRow({
        model: 'model/a',
        case_id: 'c2',
        tier: null,
        score: 0.5,
        latency_ms: 200,
        cost_usd: 0.002,
      }),
    ];

    const summaries = summarize(rows, 'classifier');
    expect(summaries).toHaveLength(1);
    const [s] = summaries;
    expect(s.model).toBe('model/a');
    expect(s.tier).toBe('*');
    expect(s.cases).toBe(2);
  });

  it('computes accuracy correctly', () => {
    const rows: CaseResultRow[] = [
      makeRow({ score: 1.0 }),
      makeRow({ case_id: 'c2', score: 0.5 }),
      makeRow({ case_id: 'c3', score: 0.0 }),
    ];

    const [s] = summarize(rows, 'classifier');
    // (1.0 + 0.5 + 0.0) / 3 = 0.5
    expect(s.accuracy).toBe(0.5);
  });

  it('computes avgCostUsd excluding null cost rows', () => {
    const rows: CaseResultRow[] = [
      makeRow({ case_id: 'c1', cost_usd: 0.002 }),
      makeRow({ case_id: 'c2', cost_usd: null }),
      makeRow({ case_id: 'c3', cost_usd: 0.004 }),
    ];

    const [s] = summarize(rows, 'classifier');
    // (0.002 + 0.004) / 2 = 0.003
    expect(s.avgCostUsd).toBe(0.003);
  });

  it('returns null avgCostUsd when all cost_usd are null', () => {
    const rows: CaseResultRow[] = [
      makeRow({ case_id: 'c1', cost_usd: null }),
      makeRow({ case_id: 'c2', cost_usd: null }),
    ];

    const [s] = summarize(rows, 'classifier');
    expect(s.avgCostUsd).toBeNull();
  });

  it('computes p50LatencyMs', () => {
    const rows: CaseResultRow[] = [
      makeRow({ case_id: 'c1', latency_ms: 100 }),
      makeRow({ case_id: 'c2', latency_ms: 300 }),
      makeRow({ case_id: 'c3', latency_ms: 200 }),
    ];

    const [s] = summarize(rows, 'classifier');
    // sorted: [100, 200, 300], floor(3/2) = 1 → 200
    expect(s.p50LatencyMs).toBe(200);
  });

  it('counts errors correctly', () => {
    const rows: CaseResultRow[] = [
      makeRow({ case_id: 'c1', score: 0, error: 'timeout' }),
      makeRow({ case_id: 'c2', score: 1, error: null }),
      makeRow({ case_id: 'c3', score: 0, error: 'rate_limit' }),
    ];

    const [s] = summarize(rows, 'classifier');
    expect(s.errors).toBe(2);
    // error rows have score 0 which drags accuracy down
    expect(s.accuracy).toBe(Number((1 / 3).toFixed(4)));
  });
});

describe('summarize — decider kind', () => {
  it('groups by tier', () => {
    const rows: CaseResultRow[] = [
      makeRow({ model: 'model/a', case_id: 'low-1', tier: 'low', score: 1 }),
      makeRow({ model: 'model/a', case_id: 'low-2', tier: 'low', score: 0 }),
      makeRow({ model: 'model/a', case_id: 'med-1', tier: 'medium', score: 1 }),
      makeRow({ model: 'model/b', case_id: 'low-3', tier: 'low', score: 1 }),
    ];

    const summaries = summarize(rows, 'decider');
    expect(summaries).toHaveLength(3);

    const aLow = summaries.find(s => s.model === 'model/a' && s.tier === 'low');
    expect(aLow?.cases).toBe(2);
    expect(aLow?.accuracy).toBe(0.5);

    const aMed = summaries.find(s => s.model === 'model/a' && s.tier === 'medium');
    expect(aMed?.cases).toBe(1);
    expect(aMed?.accuracy).toBe(1);

    const bLow = summaries.find(s => s.model === 'model/b' && s.tier === 'low');
    expect(bLow?.cases).toBe(1);
  });

  it('uses * fallback when tier is null', () => {
    const rows: CaseResultRow[] = [makeRow({ tier: null, score: 1 })];
    const [s] = summarize(rows, 'decider');
    expect(s.tier).toBe('*');
  });

  it('computes avgLatencyMs as rounded mean', () => {
    const rows: CaseResultRow[] = [
      makeRow({ case_id: 'c1', tier: 'low', latency_ms: 100 }),
      makeRow({ case_id: 'c2', tier: 'low', latency_ms: 301 }),
    ];

    const [s] = summarize(rows, 'decider');
    expect(s.avgLatencyMs).toBe(Math.round((100 + 301) / 2));
  });

  it('handles single-element groups for p50', () => {
    const rows: CaseResultRow[] = [makeRow({ tier: 'high', latency_ms: 500 })];
    const [s] = summarize(rows, 'decider');
    expect(s.p50LatencyMs).toBe(500);
  });
});

describe('runCasesWithConcurrency', () => {
  it('processes all items exactly once', async () => {
    const processed: number[] = [];
    await runCasesWithConcurrency([1, 2, 3, 4, 5], 2, async item => {
      processed.push(item);
    });
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('processes empty array without error', async () => {
    await expect(runCasesWithConcurrency([], 4, async () => {})).resolves.toBeUndefined();
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const concurrency = 3;

    await runCasesWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      concurrency,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield to allow other workers to start
        await new Promise(resolve => setTimeout(resolve, 0));
        inFlight--;
      }
    );

    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it('works when concurrency exceeds item count', async () => {
    const processed: number[] = [];
    await runCasesWithConcurrency([1, 2], 10, async item => {
      processed.push(item);
    });
    expect(processed.sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('propagates errors from the callback', async () => {
    await expect(
      runCasesWithConcurrency([1], 1, async () => {
        throw new Error('test error');
      })
    ).rejects.toThrow('test error');
  });
});
