import { describe, expect, it } from 'vitest';
import { buildScoreboard } from './build';
import { compareScoreboards } from './compare';
import {
  ReplayMetricsSchema,
  ScoreboardRoutingTableSchema,
  ScoreboardSchema,
  type ProdMetrics,
  type ReplayMetrics,
  type ScoreboardRoutingTable,
} from './schema';

const now = new Date('2026-01-01T00:00:00.000Z');
const table: ScoreboardRoutingTable = {
  version: 'fixture',
  generatedAt: now.toISOString(),
  minAccuracy: 0.5,
  switchCostFactor: 2,
  bestAccuracySwitchThreshold: 0.05,
  source: 'benchmark',
  routes: {
    'implementation/code_generation': [
      {
        model: 'fixture/first',
        accuracy: 0.8,
        avgCostUsd: 0.02,
        p50LatencyMs: 100,
        meetsThreshold: true,
      },
      {
        model: 'fixture/second',
        accuracy: 1,
        avgCostUsd: 0.5,
        p50LatencyMs: 900,
        meetsThreshold: true,
      },
    ],
    'debugging/bug_fixing': [
      {
        model: 'fixture/third',
        accuracy: 0.6,
        avgCostUsd: 0.06,
        p50LatencyMs: 300,
        meetsThreshold: true,
      },
    ],
  },
};

function prod(routeMix: Record<string, number>): ProdMetrics {
  return {
    kind: 'prod',
    window: { start: now.toISOString(), end: now.toISOString() },
    gatewayDecideMs: null,
    workerDecideMs: null,
    workerPhasesMs: null,
    cacheHitRate: null,
    classifierPerRequestUsd: null,
    switchRate: null,
    routeMix,
    modelTtftMs: null,
    prodPerRequestUsd: { mean: null, p50: null },
    prodCacheReadShare: null,
  };
}

function build(
  inputTable: ScoreboardRoutingTable,
  metrics: ProdMetrics | null = null,
  replay: ReplayMetrics | null = null
) {
  return buildScoreboard({
    label: 'fixture',
    table: inputTable,
    classifierRouteAccuracy: 0.75,
    prod: metrics,
    replay,
    now,
  });
}

describe('buildScoreboard', () => {
  it('weights first candidates over shared routes and excludes routes missing from the mix', () => {
    const result = build(
      table,
      prod({ 'implementation/code_generation': 0.25, 'implementation/test_creation': 0.75 })
    );
    expect(result.quality.benchmarkAccuracyWeighted).toBe(0.8);
    expect(result.cost.benchmarkPerTaskUsdWeighted).toBe(0.02);
    expect(result.latency.modelTtftMs.benchmarkP50Weighted).toBe(100);
    expect(ScoreboardSchema.parse(result)).toEqual(result);
  });

  it('skips null latency and renormalizes its metric without changing other weights', () => {
    const withNullLatency: ScoreboardRoutingTable = {
      ...table,
      routes: {
        ...table.routes,
        'implementation/code_generation': [
          { ...table.routes['implementation/code_generation'][0], p50LatencyMs: null },
        ],
      },
    };
    const result = build(
      withNullLatency,
      prod({ 'implementation/code_generation': 0.75, 'debugging/bug_fixing': 0.25 })
    );
    expect(result.latency.modelTtftMs.benchmarkP50Weighted).toBe(300);
    expect(result.quality.benchmarkAccuracyWeighted).toBeCloseTo(0.75);
    expect(result.cost.benchmarkPerTaskUsdWeighted).toBeCloseTo(0.03);
  });

  it('uses uniform table-route weights when production metrics are absent', () => {
    const result = build(table);
    expect(result.routeMix).toEqual({
      'implementation/code_generation': 0.5,
      'debugging/bug_fixing': 0.5,
    });
    expect(result.quality.benchmarkAccuracyWeighted).toBeCloseTo(0.7);
    expect(result.cost.benchmarkPerTaskUsdWeighted).toBeCloseTo(0.04);
    expect(result.latency.modelTtftMs.benchmarkP50Weighted).toBe(200);
    expect(result.cost.prodPerRequestUsd).toEqual({ mean: null, p50: null });
  });

  it('preserves optional file latency values without altering the published table contract', () => {
    const parsed = ScoreboardRoutingTableSchema.parse(table);
    expect(parsed.routes['implementation/code_generation'][0].p50LatencyMs).toBe(100);
    const withoutLatency = {
      ...table,
      routes: {
        'debugging/bug_fixing': [
          { model: 'fixture/default', accuracy: 0.5, avgCostUsd: 0.01, meetsThreshold: true },
        ],
      },
    };
    expect(
      build(ScoreboardRoutingTableSchema.parse(withoutLatency)).latency.modelTtftMs
        .benchmarkP50Weighted
    ).toBeNull();
  });
});

describe('compareScoreboards', () => {
  it('marks lower latency and higher quality as better and summarizes the axes', () => {
    const base = build(table);
    const head = structuredClone(base);
    head.latency.modelTtftMs.benchmarkP50Weighted = 150;
    head.quality.classifierRouteAccuracy = 0.9;
    head.cost.benchmarkPerTaskUsdWeighted = 0.05;
    const markdown = compareScoreboards(base, head, { relativeOnly: false });
    expect(markdown).toContain(
      '| latency.modelTtftMs.benchmarkP50Weighted | 200 | 150 | -25.00% | better |'
    );
    expect(markdown).toContain(
      '| quality.classifierRouteAccuracy | 0.75 | 0.9 | +20.00% | better |'
    );
    expect(markdown).toMatch(/latency: better\ncost: worse\nquality: better$/);
  });

  it('omits absolute values in relative-only output and marks sub-percent changes flat', () => {
    const base = build(table);
    const head = structuredClone(base);
    head.latency.modelTtftMs.benchmarkP50Weighted = 199;
    const markdown = compareScoreboards(base, head, { relativeOnly: true });
    expect(markdown).toContain('| latency.modelTtftMs.benchmarkP50Weighted | -0.50% | flat |');
    expect(markdown).not.toContain('| Base |');
    expect(markdown).not.toContain('| Head |');
    expect(markdown).not.toContain('200');
    expect(markdown).not.toContain('199');
    expect(markdown).not.toContain('0.75');
    expect(compareScoreboards(base, base, { relativeOnly: true })).toMatch(
      /latency: flat\ncost: flat\nquality: flat$/
    );
  });

  it('preserves replay costs and compares them as lower-is-better cost metrics', () => {
    const scenario = { n: 1, p50: 10, p90: 10, p99: 10, errors: 0 };
    const replay = ReplayMetricsSchema.parse({
      kind: 'replay',
      target: 'http://localhost:8810',
      startedAt: now.toISOString(),
      sessions: 1,
      scenarios: {
        cold: { ...scenario, costUsd: 0.02 },
        warm_new_turn: scenario,
        exact_repeat: scenario,
      },
    });
    const base = build(table, null, replay);
    expect(ScoreboardSchema.parse(base).latency.routerOverheadMs.replay).toEqual(replay.scenarios);
    const head = structuredClone(base);
    head.latency.routerOverheadMs.replay = {
      ...replay.scenarios,
      cold: { ...replay.scenarios.cold, costUsd: 0.01 },
    };
    const markdown = compareScoreboards(base, head, { relativeOnly: false });
    expect(markdown).toContain('| replay.cold.costUsd | 0.02 | 0.01 | -50.00% | better |');
    expect(markdown).not.toContain('replay.warm_new_turn.costUsd');
    expect(markdown).toMatch(/latency: flat\ncost: better\nquality: flat$/);
    expect(() =>
      ReplayMetricsSchema.parse({
        ...replay,
        scenarios: { ...replay.scenarios, cold: { ...scenario, costUsd: -1 } },
      })
    ).toThrow();
  });

  it('handles missing and zero baselines without NaN or false improvements', () => {
    const base = build(table);
    const head = structuredClone(base);
    base.cost.classifierPerRequestUsd = 0;
    head.cost.classifierPerRequestUsd = 0.01;
    const markdown = compareScoreboards(base, head, { relativeOnly: true });
    expect(markdown).toContain('| cost.classifierPerRequestUsd | +∞% | worse |');
    expect(markdown).not.toContain('latency.cacheHitRate');
    expect(markdown).not.toContain('NaN');
  });
});
