import { describe, expect, it } from 'vitest';
import type { CaseResultRow } from './db';
import {
  BenchmarkJobMessageSchema,
  buildClassifierMessages,
  buildDeciderMessages,
  chunkArray,
  computeEngineIdentity,
  runCasesWithConcurrency,
  summarize,
} from './run';
import { pickClassifierWinner } from './winner';

function makeRow(overrides: Partial<CaseResultRow> = {}): CaseResultRow {
  return {
    run_id: 'run-1',
    model: 'model/a',
    case_id: 'case-1',
    tier: null,
    score: 1,
    latency_ms: 100,
    cost_usd: 0.001,
    error: null,
    fallback_reason: null,
    retried: null,
    exit_code: null,
    output_prefix: null,
    event_count: null,
    last_event_types: null,
    rep: 0,
    timed_out: 0,
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

describe('computeEngineIdentity', () => {
  it('is deterministic for a given kind', () => {
    expect(computeEngineIdentity('classifier')).toBe(computeEngineIdentity('classifier'));
    expect(computeEngineIdentity('decider')).toBe(computeEngineIdentity('decider'));
  });

  it('differs between classifier and decider datasets', () => {
    expect(computeEngineIdentity('classifier')).not.toBe(computeEngineIdentity('decider'));
  });

  it('is versioned (carries the engine version prefix)', () => {
    expect(computeEngineIdentity('decider')).toMatch(/^v\d+:[0-9a-f]{8}$/);
  });
});

describe('chunkArray', () => {
  it('splits into 5-per-chunk with a partial final chunk', () => {
    const items = Array.from({ length: 13 }, (_, i) => i);
    const chunks = chunkArray(items, 5);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5);
    expect(chunks[1]).toHaveLength(5);
    expect(chunks[2]).toHaveLength(3);
  });

  it('round-trips caseIds: flatten equals the original order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'];
    const chunks = chunkArray(ids, 10);
    expect(chunks).toHaveLength(2);
    expect(chunks.flat()).toEqual(ids);
  });

  it('returns a single full chunk when items fit exactly', () => {
    const chunks = chunkArray([1, 2, 3, 4, 5], 5);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns no chunks for an empty array', () => {
    expect(chunkArray([], 10)).toEqual([]);
  });
});

describe('pickClassifierWinner', () => {
  const summary = (model: string, accuracy: number, avgCostUsd: number | null) => ({
    model,
    tier: '*' as const,
    accuracy,
    avgCostUsd,
    avgLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 90,
    cases: 36,
    errors: 0,
    timeouts: 0,
  });

  it('picks the cheapest model meeting the threshold', () => {
    const winner = pickClassifierWinner(
      [summary('pricy', 0.95, 0.01), summary('cheap', 0.9, 0.001), summary('weak', 0.5, 0.0001)],
      0.7
    );
    expect(winner?.model).toBe('cheap');
  });

  it('falls back to highest accuracy when nothing meets the threshold', () => {
    const winner = pickClassifierWinner([summary('a', 0.5, 0.001), summary('b', 0.6, 0.01)], 0.9);
    expect(winner?.model).toBe('b');
  });

  it('treats null cost as most expensive', () => {
    const winner = pickClassifierWinner(
      [summary('nocost', 0.95, null), summary('cheap', 0.9, 0.001)],
      0.7
    );
    expect(winner?.model).toBe('cheap');
  });

  it('ignores decider-tier summaries and returns null when nothing is graded', () => {
    expect(
      pickClassifierWinner([{ ...summary('m', 1, 0.001), tier: 'low' as const }], 0.7)
    ).toBeNull();
    expect(pickClassifierWinner([], 0.7)).toBeNull();
  });

  // helper with explicit p95LatencyMs
  const summaryWithLatency = (
    model: string,
    accuracy: number,
    avgCostUsd: number | null,
    p95: number | null = 90
  ) => ({
    model,
    tier: '*' as const,
    accuracy,
    avgCostUsd,
    avgLatencyMs: 100,
    p50LatencyMs: 80,
    p95LatencyMs: p95,
    timeouts: 0,
    cases: 36,
    errors: 0,
  });

  it('latency gate: picks cheapest within budget when both meet accuracy and latency', () => {
    const winner = pickClassifierWinner(
      [
        summaryWithLatency('fast-cheap', 0.9, 0.001, 800),
        summaryWithLatency('fast-pricy', 0.95, 0.01, 500),
        summaryWithLatency('slow', 0.9, 0.0005, 1500),
      ],
      0.7,
      1000
    );
    expect(winner?.model).toBe('fast-cheap');
  });

  it('latency gate fallback: picks lowest p95 among accuracy-meeting when none in budget', () => {
    const winner = pickClassifierWinner(
      [
        summaryWithLatency('almost', 0.9, 0.001, 1200),
        summaryWithLatency('closest', 0.85, 0.002, 1100),
        summaryWithLatency('way-off', 0.9, 0.0005, 2000),
      ],
      0.8,
      1000
    );
    expect(winner?.model).toBe('closest');
  });

  it('null budget disables latency gate', () => {
    const winner = pickClassifierWinner(
      [
        summaryWithLatency('cheap-slow', 0.9, 0.001, 5000),
        summaryWithLatency('pricy-fast', 0.95, 0.01, 100),
      ],
      0.7,
      null
    );
    expect(winner?.model).toBe('cheap-slow');
  });

  it('null p95 on summary fails non-null latency constraint', () => {
    const winner = pickClassifierWinner(
      [
        summaryWithLatency('no-p95', 0.9, 0.001, null),
        summaryWithLatency('has-p95', 0.85, 0.01, 800),
      ],
      0.7,
      1000
    );
    // no-p95 fails the gate (null p95 cannot meet non-null constraint)
    // has-p95 meets both → wins
    expect(winner?.model).toBe('has-p95');
  });
});

describe('summarize — p95 and timeouts', () => {
  it('computes p95LatencyMs using nearest-rank formula', () => {
    // 20 rows, sorted latencies at 95th percentile: ceil(0.95*20)-1 = 18
    const rows = Array.from({ length: 20 }, (_, i) =>
      makeRow({ case_id: `c${i}`, latency_ms: (i + 1) * 100 })
    );
    const [s] = summarize(rows, 'classifier');
    // sorted latencies: [100, 200, ..., 2000], index 18 = 1900
    expect(s.p95LatencyMs).toBe(1900);
  });

  it('counts timeouts', () => {
    const rows = [
      makeRow({ case_id: 'c1', timed_out: 1 }),
      makeRow({ case_id: 'c2', timed_out: 0 }),
      makeRow({ case_id: 'c3', timed_out: 1 }),
    ];
    const [s] = summarize(rows, 'classifier');
    expect(s.timeouts).toBe(2);
  });

  it('aggregates multi-rep rows correctly (same case_id different rep)', () => {
    const rows = [
      makeRow({ case_id: 'c1', rep: 0, score: 1, latency_ms: 100 }),
      makeRow({ case_id: 'c1', rep: 1, score: 0, latency_ms: 200 }),
      makeRow({ case_id: 'c2', rep: 0, score: 1, latency_ms: 150 }),
      makeRow({ case_id: 'c2', rep: 1, score: 1, latency_ms: 250 }),
    ];
    const [s] = summarize(rows, 'classifier');
    expect(s.cases).toBe(4);
    expect(s.accuracy).toBe(0.75);
  });
});

describe('decider message fan-out', () => {
  it('DECIDER_CHUNK_SIZE is 5 (chunk count for 76 cases)', () => {
    // DECIDER_CASES = 76, chunk size 5 → ceil(76/5) = 16 chunks
    const chunks = chunkArray(
      Array.from({ length: 76 }, (_, i) => String(i)),
      5
    );
    expect(chunks).toHaveLength(16);
  });

  it('message schema accepts and defaults rep', () => {
    const msg = BenchmarkJobMessageSchema.parse({ runId: 'r1', kind: 'classifier', model: 'm1' });
    expect(msg.rep).toBeUndefined();
    const withRep = BenchmarkJobMessageSchema.parse({
      runId: 'r1',
      kind: 'decider',
      model: 'm1',
      rep: 2,
      caseIds: ['a'],
      chunk: 0,
    });
    expect(withRep.rep).toBe(2);
  });

  it('buildDeciderMessages: produces models × reps × ceil(76/5) messages with correct rep', () => {
    // 76 cases, chunk size 5 → 16 chunks
    const cases76 = Array.from({ length: 76 }, (_, i) => ({ id: `case-${i}` }));
    const chunks = chunkArray(cases76, 5);
    expect(chunks).toHaveLength(16);

    const models = ['model/a', 'model/b'];
    const repetitions = 3;
    const messages = buildDeciderMessages('run-test', 'decider', models, repetitions, chunks);

    // Total: 2 models × 3 reps × 16 chunks = 96 messages
    expect(messages).toHaveLength(models.length * repetitions * chunks.length);

    // Each rep index (0..2) should appear exactly models.length × chunks.length times
    for (let rep = 0; rep < repetitions; rep++) {
      const forRep = messages.filter(m => m.body.rep === rep);
      expect(forRep).toHaveLength(models.length * chunks.length);
    }

    // Every message carries the correct rep in its body
    for (const { body } of messages) {
      expect(typeof body.rep).toBe('number');
      expect(body.rep).toBeGreaterThanOrEqual(0);
      expect(body.rep).toBeLessThan(repetitions);
    }

    // caseIds on each message match the chunk
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const forChunk = messages.filter(m => m.body.chunk === chunkIdx);
      for (const { body } of forChunk) {
        expect(body.caseIds).toEqual(chunks[chunkIdx].map(c => c.id));
      }
    }
  });
});

describe('classifier message fan-out', () => {
  it('buildClassifierMessages: produces models × reps × chunks messages with case IDs', () => {
    const cases72 = Array.from({ length: 72 }, (_, i) => ({ id: `case-${i}` }));
    const chunks = chunkArray(cases72, 4);
    expect(chunks).toHaveLength(18);

    const models = ['model/a', 'model/b'];
    const repetitions = 3;
    const messages = buildClassifierMessages('run-test', models, repetitions, chunks);

    expect(messages).toHaveLength(models.length * repetitions * chunks.length);

    for (let rep = 0; rep < repetitions; rep++) {
      const forRep = messages.filter(m => m.body.rep === rep);
      expect(forRep).toHaveLength(models.length * chunks.length);
    }

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const forChunk = messages.filter(m => m.body.chunk === chunkIdx);
      expect(forChunk).toHaveLength(models.length * repetitions);
      for (const { body } of forChunk) {
        expect(body.kind).toBe('classifier');
        expect(body.caseIds).toEqual(chunks[chunkIdx].map(c => c.id));
      }
    }
  });
});
