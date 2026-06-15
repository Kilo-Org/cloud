import { describe, expect, it } from 'vitest';
import type {
  BenchmarkDeciderModel,
  BenchmarkModelSummary,
} from '@kilocode/auto-routing-contracts';
import { buildRoutingTable } from './routing-table-builder';

const DECIDER_MODELS: BenchmarkDeciderModel[] = [
  { id: 'model/cheap', reasoningEffort: null },
  { id: 'model/expensive', reasoningEffort: 'medium' },
  { id: 'model/mid', reasoningEffort: null },
];

function summary(
  model: string,
  tier: BenchmarkModelSummary['tier'],
  accuracy: number,
  avgCostUsd: number | null = 0.001
): BenchmarkModelSummary {
  return {
    model,
    tier,
    accuracy,
    avgCostUsd,
    avgLatencyMs: 500,
    p50LatencyMs: 450,
    p95LatencyMs: null,
    cases: 10,
    errors: 0,
    timeouts: 0,
  };
}

const ALL_TIERS_SUMMARIES: BenchmarkModelSummary[] = [
  summary('model/cheap', 'low', 0.9, 0.001),
  summary('model/expensive', 'low', 0.95, 0.01),
  summary('model/mid', 'low', 0.8, 0.005),
  summary('model/cheap', 'medium', 0.75, 0.001),
  summary('model/expensive', 'medium', 0.85, 0.01),
  summary('model/mid', 'medium', 0.72, 0.005),
  summary('model/cheap', 'high', 0.6, 0.001),
  summary('model/expensive', 'high', 0.9, 0.01),
  summary('model/mid', 'high', 0.75, 0.005),
];

describe('buildRoutingTable', () => {
  it('cheapest above-threshold model comes first per tier', () => {
    const table = buildRoutingTable({
      runId: 'test-run-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries: ALL_TIERS_SUMMARIES,
    });

    // low tier: cheap (0.001) and mid (0.005) and expensive (0.01) all meet threshold (0.7)
    // cheapest first
    expect(table.tiers.low[0].model).toBe('model/cheap');
    expect(table.tiers.low[1].model).toBe('model/mid');
    expect(table.tiers.low[2].model).toBe('model/expensive');

    // medium tier: all meet threshold, cheapest first
    expect(table.tiers.medium[0].model).toBe('model/cheap');
    expect(table.tiers.medium[1].model).toBe('model/mid');
    expect(table.tiers.medium[2].model).toBe('model/expensive');

    // high tier: expensive (0.9) and mid (0.75) meet threshold; cheap (0.6) does not
    // meeting threshold first, then by cost; cheap last (below threshold)
    expect(table.tiers.high[0].model).toBe('model/mid'); // meets threshold, cheaper
    expect(table.tiers.high[1].model).toBe('model/expensive'); // meets threshold, more expensive
    expect(table.tiers.high[2].model).toBe('model/cheap'); // below threshold
  });

  it('excludes a model whose tier summary has no cost signal', () => {
    const table = buildRoutingTable({
      runId: 'test-run-nocost',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries: ALL_TIERS_SUMMARIES.map(s =>
        s.model === 'model/cheap' && s.tier === 'low' ? { ...s, avgCostUsd: null } : s
      ),
    });

    // model/cheap would have won 'low' as cheapest; without a cost signal it
    // must not be ranked (unknown cost is not zero cost).
    expect(table.tiers.low.map(c => c.model)).toEqual(['model/mid', 'model/expensive']);
  });

  it('marks meetsThreshold correctly', () => {
    const table = buildRoutingTable({
      runId: 'test-run-2',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries: ALL_TIERS_SUMMARIES,
    });

    for (const candidate of table.tiers.low) {
      expect(candidate.meetsThreshold).toBe(candidate.accuracy >= 0.7);
    }
  });

  it('excludes a model absent from a tier summaries', () => {
    // model/cheap has no 'high' summary entry
    const summaries: BenchmarkModelSummary[] = [
      summary('model/cheap', 'low', 0.9),
      summary('model/cheap', 'medium', 0.8),
      // no 'high' entry for model/cheap
      summary('model/expensive', 'low', 0.9),
      summary('model/expensive', 'medium', 0.8),
      summary('model/expensive', 'high', 0.9),
      summary('model/mid', 'low', 0.8),
      summary('model/mid', 'medium', 0.75),
      summary('model/mid', 'high', 0.75),
    ];

    const table = buildRoutingTable({
      runId: 'test-run-3',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries,
    });

    const highModels = table.tiers.high.map(c => c.model);
    expect(highModels).not.toContain('model/cheap');
    expect(highModels).toContain('model/expensive');
    expect(highModels).toContain('model/mid');
  });

  it('carries reasoningEffort from the run snapshot', () => {
    const table = buildRoutingTable({
      runId: 'test-run-4',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries: ALL_TIERS_SUMMARIES,
    });

    const expensiveInLow = table.tiers.low.find(c => c.model === 'model/expensive');
    expect(expensiveInLow?.reasoningEffort).toBe('medium');

    const midInLow = table.tiers.low.find(c => c.model === 'model/mid');
    expect(midInLow?.reasoningEffort).toBeNull();
  });

  it('defaults reasoningEffort to null when model missing from the snapshot', () => {
    const summaries: BenchmarkModelSummary[] = [
      summary('model/unknown', 'low', 0.9),
      summary('model/cheap', 'low', 0.8),
      summary('model/cheap', 'medium', 0.8),
      summary('model/cheap', 'high', 0.8),
      summary('model/unknown', 'medium', 0.9),
      summary('model/unknown', 'high', 0.9),
    ];

    const table = buildRoutingTable({
      runId: 'test-run-5',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries,
    });

    const unknown = table.tiers.low.find(c => c.model === 'model/unknown');
    expect(unknown?.reasoningEffort).toBeNull();
  });

  it('throws when a tier has no candidates', () => {
    // Only low and medium summaries — high is missing entirely
    const summaries: BenchmarkModelSummary[] = [
      summary('model/cheap', 'low', 0.9),
      summary('model/expensive', 'low', 0.9),
      summary('model/mid', 'low', 0.9),
      summary('model/cheap', 'medium', 0.9),
      summary('model/expensive', 'medium', 0.9),
      summary('model/mid', 'medium', 0.9),
    ];

    expect(() =>
      buildRoutingTable({
        runId: 'test-run-6',
        generatedAt: '2026-01-01T00:00:00.000Z',
        minAccuracy: 0.7,
        switchCostFactor: 3,
        deciderModels: DECIDER_MODELS,
        summaries,
      })
    ).toThrow();
  });

  it('throws when a tier has only zero-case entries', () => {
    const summaries: BenchmarkModelSummary[] = [
      ...ALL_TIERS_SUMMARIES.filter(s => s.tier !== 'high'),
      // high tier entries with 0 cases — should be excluded
      { ...summary('model/cheap', 'high', 0.9), cases: 0 },
      { ...summary('model/expensive', 'high', 0.9), cases: 0 },
      { ...summary('model/mid', 'high', 0.9), cases: 0 },
    ];

    expect(() =>
      buildRoutingTable({
        runId: 'test-run-7',
        generatedAt: '2026-01-01T00:00:00.000Z',
        minAccuracy: 0.7,
        switchCostFactor: 3,
        deciderModels: DECIDER_MODELS,
        summaries,
      })
    ).toThrow();
  });

  it('ignores classifier-style * tier summaries', () => {
    const summaries: BenchmarkModelSummary[] = [
      ...ALL_TIERS_SUMMARIES,
      // classifier summaries with '*' tier — should be ignored
      summary('model/cheap', '*', 0.95),
      summary('model/expensive', '*', 0.95),
    ];

    // Should not throw and * tier entries should not affect output
    const table = buildRoutingTable({
      runId: 'test-run-8',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries,
    });

    expect(table.tiers.low.length).toBe(3);
    expect(table.tiers.medium.length).toBe(3);
  });

  it('sets version and generatedAt from params', () => {
    const table = buildRoutingTable({
      runId: 'decider-2026-01-01',
      generatedAt: '2026-01-01T12:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      deciderModels: DECIDER_MODELS,
      summaries: ALL_TIERS_SUMMARIES,
    });

    expect(table.version).toBe('decider-2026-01-01');
    expect(table.generatedAt).toBe('2026-01-01T12:00:00.000Z');
    expect(table.source).toBe('benchmark');
    expect(table.minAccuracy).toBe(0.7);
    expect(table.switchCostFactor).toBe(3);
  });
});
