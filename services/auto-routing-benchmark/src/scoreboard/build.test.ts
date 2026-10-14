import { describe, expect, it } from 'vitest';
import { rowsToRoutingTable } from '../db';
import { buildScoreboard } from './build';
import { compareScoreboards } from './compare';
import { estimateClassifiedMetrics } from './production';
import {
  LiveScoreboardCandidateRowSchema,
  LiveScoreboardTableRowSchema,
  ReplayMetricsSchema,
  ScoreboardRoutingTableSchema,
  ScoreboardSchema,
  type OfflineSweep,
  type OfflineSweepSummary,
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
    shadow: null,
  };
}

function build(
  inputTable: ScoreboardRoutingTable,
  metrics: ProdMetrics | null = null,
  replay: ReplayMetrics | null = null,
  options: Pick<
    Parameters<typeof buildScoreboard>[0],
    'costProfile' | 'rerankProfile' | 'sweep' | 'rebuildFromSweep' | 'pricing'
  > = {}
) {
  return buildScoreboard({
    label: 'fixture',
    table: inputTable,
    classifierRouteAccuracy: 0.75,
    prod: metrics,
    replay,
    now,
    ...options,
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

  it('leaves estimated request cost unavailable without candidate pricing', () => {
    expect(build(table).cost.estimatedRequestUsdWeighted).toBeNull();
    expect(
      build(table, null, null, {
        costProfile: { uncachedInputTokens: 10, cachedInputTokens: 100 },
      }).cost.estimatedRequestUsdWeighted
    ).toBeNull();
  });

  it('uses persisted live-table pricing and token profile without override flags', () => {
    const profile = { uncachedInputTokens: 10, cachedInputTokens: 100 };
    const pricing = {
      promptUsdPerToken: 0.01,
      completionUsdPerToken: 0.02,
      cacheReadUsdPerToken: 0.001,
    };
    const tableRow = LiveScoreboardTableRowSchema.parse({
      run_id: 'fixture/live',
      published_at: now.toISOString(),
      generated_at: now.toISOString(),
      min_accuracy: 0.5,
      switch_cost_factor: 2,
      best_accuracy_switch_threshold: 0.05,
      production_token_profile: JSON.stringify(profile),
      switch_horizon_turns: 3,
      source: 'benchmark',
    });
    const candidateRow = LiveScoreboardCandidateRowSchema.parse({
      run_id: tableRow.run_id,
      route_key: 'implementation/code_generation',
      rank: 0,
      model: 'fixture/priced',
      accuracy: 0.8,
      avg_cost_usd: 0.02,
      meets_threshold: 1,
      reasoning_effort: null,
      variant: '',
      pricing: JSON.stringify(pricing),
      estimated_request_cost_usd: 0.22,
      p50LatencyMs: 100,
    });
    const parsed = ScoreboardRoutingTableSchema.parse(rowsToRoutingTable(tableRow, [candidateRow]));
    expect(parsed.productionTokenProfile).toEqual(profile);
    expect(parsed.switchHorizonTurns).toBe(3);
    expect(parsed.routes['implementation/code_generation'][0]).toMatchObject({
      pricing,
      estimatedRequestCostUsd: 0.22,
      meetsThreshold: true,
    });
    expect(build(parsed).cost.estimatedRequestUsdWeighted).toBeCloseTo(0.22);
  });

  it('weights prompt-aware estimates without changing the published first picks', () => {
    const pricedTable: ScoreboardRoutingTable = {
      ...table,
      routes: {
        'implementation/code_generation': table.routes['implementation/code_generation'].map(
          candidate => ({
            ...candidate,
            pricing: {
              promptUsdPerToken: 0.01,
              completionUsdPerToken: 0.02,
              cacheReadUsdPerToken: 0.001,
            },
          })
        ),
        'debugging/bug_fixing': table.routes['debugging/bug_fixing'].map(candidate => ({
          ...candidate,
          pricing: {
            promptUsdPerToken: 0.02,
            completionUsdPerToken: 0.04,
            cacheReadUsdPerToken: 0.002,
          },
        })),
      },
    };
    const result = build(
      pricedTable,
      prod({ 'implementation/code_generation': 0.25, 'debugging/bug_fixing': 0.75 }),
      null,
      { costProfile: { uncachedInputTokens: 10, cachedInputTokens: 100 } }
    );
    expect(result.cost.estimatedRequestUsdWeighted).toBeCloseTo(0.4);
    expect(result.cost.benchmarkPerTaskUsdWeighted).toBeCloseTo(0.05);
    expect(result.latency.modelTtftMs.benchmarkP50Weighted).toBe(250);
    expect(result.quality.benchmarkAccuracyWeighted).toBeCloseTo(0.65);

    delete pricedTable.routes['debugging/bug_fixing'][0].pricing;
    expect(
      build(pricedTable, null, null, {
        costProfile: { uncachedInputTokens: 10, cachedInputTokens: 100 },
      }).cost.estimatedRequestUsdWeighted
    ).toBeNull();
  });

  it('reranks for cheaper prompts and compares estimates using the same cost profile', () => {
    const profile = { uncachedInputTokens: 10, cachedInputTokens: 100 };
    const pricedTable: ScoreboardRoutingTable = {
      ...table,
      routes: {
        'implementation/code_generation': [
          {
            model: 'fixture/expensive-prompt',
            accuracy: 0.8,
            avgCostUsd: 0.02,
            p50LatencyMs: 100,
            meetsThreshold: true,
            pricing: {
              promptUsdPerToken: 0.01,
              completionUsdPerToken: 0.02,
              cacheReadUsdPerToken: 0.001,
            },
          },
          {
            model: 'fixture/cheap-prompt',
            accuracy: 0.8,
            avgCostUsd: 0.04,
            p50LatencyMs: 100,
            meetsThreshold: true,
            pricing: {
              promptUsdPerToken: 0.001,
              completionUsdPerToken: 0.002,
              cacheReadUsdPerToken: 0.0001,
            },
          },
        ],
      },
    };
    const sweep: OfflineSweep = {
      startedAt: now.toISOString(),
      truncated: false,
      costUsd: 0,
      graderCostUsd: 0,
      pairs: [],
      summaries: [
        {
          model: 'fixture/expensive-prompt',
          variant: null,
          routeKey: 'implementation/code_generation',
          split: 'heldOut',
          accuracy: 0.2,
          cases: 10,
          avgCostUsd: 0.3,
          p50LatencyMs: 500,
        },
        {
          model: 'fixture/cheap-prompt',
          variant: null,
          routeKey: 'implementation/code_generation',
          split: 'heldOut',
          accuracy: 0.9,
          cases: 10,
          avgCostUsd: 0.03,
          p50LatencyMs: 150,
        },
      ],
    };
    const base = build(pricedTable, null, null, { costProfile: profile, sweep });
    const head = build(pricedTable, null, null, {
      costProfile: profile,
      rerankProfile: profile,
      sweep,
    });
    expect(base.cost.benchmarkPerTaskUsdWeighted).toBe(0.02);
    expect(head.cost.benchmarkPerTaskUsdWeighted).toBe(0.04);
    expect(base.cost.estimatedRequestUsdWeighted).toBeCloseTo(0.22);
    expect(head.cost.estimatedRequestUsdWeighted).toBeCloseTo(0.06);
    expect(head.latency.modelTtftMs.benchmarkP50Weighted).toBe(100);
    expect(head.quality.benchmarkAccuracyWeighted).toBe(0.8);
    expect(base.quality.heldOut?.accuracyWeighted).toBe(0.2);
    expect(base.quality.heldOut?.estimatedRequestUsdWeighted).toBeCloseTo(0.5);
    expect(head.quality.heldOut?.accuracyWeighted).toBe(0.9);
    expect(head.quality.heldOut?.estimatedRequestUsdWeighted).toBeCloseTo(0.05);
    expect(head.quality.heldOut?.p50LatencyMsWeighted).toBe(150);
    expect(
      build(pricedTable, null, null, { rerankProfile: profile }).cost.estimatedRequestUsdWeighted
    ).toBeCloseTo(0.06);
    expect(compareScoreboards(base, head, { relativeOnly: true })).toContain(
      '| cost.estimatedRequestUsdWeighted | -72.73% | better |'
    );
    expect(pricedTable.routes['implementation/code_generation'][0].model).toBe(
      'fixture/expensive-prompt'
    );
  });

  it('evaluates the exact first pick on held-out data instead of selecting the best held-out score', () => {
    const summaries: OfflineSweepSummary[] = [
      {
        model: 'fixture/first',
        variant: null,
        routeKey: 'implementation/code_generation',
        split: 'heldOut',
        accuracy: 0.2,
        cases: 10,
        avgCostUsd: 0.03,
        p50LatencyMs: 500,
      },
      {
        model: 'fixture/second',
        variant: null,
        routeKey: 'implementation/code_generation',
        split: 'heldOut',
        accuracy: 1,
        cases: 10,
        avgCostUsd: 0.01,
        p50LatencyMs: 100,
      },
      {
        model: 'fixture/third',
        variant: null,
        routeKey: 'debugging/bug_fixing',
        split: 'heldOut',
        accuracy: 0.8,
        cases: 10,
        avgCostUsd: 0.01,
        p50LatencyMs: 100,
      },
    ];
    const sweep: OfflineSweep = {
      startedAt: now.toISOString(),
      truncated: false,
      costUsd: 0,
      graderCostUsd: 0,
      pairs: [],
      summaries,
    };
    const result = build(
      table,
      prod({ 'implementation/code_generation': 0.75, 'debugging/bug_fixing': 0.25 }),
      null,
      { sweep }
    );
    expect(result.quality.heldOut?.accuracyWeighted).toBeCloseTo(0.35);
    expect(result.quality.heldOut?.estimatedRequestUsdWeighted).toBeCloseTo(0.025);
    expect(result.quality.heldOut).toMatchObject({
      p50LatencyMsWeighted: 400,
      routes: 2,
    });
    expect(ScoreboardSchema.parse(result)).toEqual(result);
  });

  it('rebuilds from train only with pricing and evaluates new picks on held-out costs and latency', () => {
    const summary: OfflineSweepSummary = {
      model: 'fixture/first',
      variant: null,
      routeKey: 'implementation/code_generation',
      split: 'train',
      accuracy: 0.8,
      cases: 100,
      avgCostUsd: 0.4,
      p50LatencyMs: 1000,
    };
    const sweep: OfflineSweep = {
      startedAt: now.toISOString(),
      truncated: false,
      costUsd: 0,
      graderCostUsd: 0,
      pairs: [],
      summaries: [
        summary,
        { ...summary, model: 'fixture/second', avgCostUsd: 0.02, p50LatencyMs: 100 },
        { ...summary, split: 'heldOut', accuracy: 0.2, avgCostUsd: 0.03, p50LatencyMs: 500 },
        {
          ...summary,
          model: 'fixture/second',
          split: 'heldOut',
          accuracy: 0.9,
          avgCostUsd: 0.015,
          p50LatencyMs: 150,
        },
        {
          ...summary,
          model: 'fixture/held-out-only',
          split: 'heldOut',
          accuracy: 1,
          avgCostUsd: 0.000001,
          p50LatencyMs: 1,
        },
      ],
    };
    const pricing = {
      'fixture/first': {
        promptUsdPerToken: 0.001,
        completionUsdPerToken: 0.002,
        cacheReadUsdPerToken: 0.0001,
      },
      'fixture/second': {
        promptUsdPerToken: 0.001,
        completionUsdPerToken: 0.002,
        cacheReadUsdPerToken: 0.0001,
      },
    };
    const costProfile = { uncachedInputTokens: 10, cachedInputTokens: 100 };
    const pricedTable: ScoreboardRoutingTable = {
      ...table,
      routes: {
        'implementation/code_generation': [
          {
            ...table.routes['implementation/code_generation'][0],
            pricing: pricing['fixture/first'],
          },
        ],
      },
    };
    const base = build(pricedTable, null, null, { sweep, costProfile });
    const head = build(pricedTable, null, null, {
      sweep,
      costProfile,
      pricing,
      rebuildFromSweep: true,
    });
    expect(head.quality.benchmarkAccuracyWeighted).toBe(0.8);
    expect(head.cost.benchmarkPerTaskUsdWeighted).toBe(0.02);
    expect(head.latency.modelTtftMs.benchmarkP50Weighted).toBe(100);
    expect(head.quality.heldOut?.accuracyWeighted).toBe(0.9);
    expect(head.quality.heldOut?.estimatedRequestUsdWeighted).toBeCloseTo(0.035);
    expect(head.quality.heldOut?.p50LatencyMsWeighted).toBe(150);
    expect(head.quality.heldOut?.routes).toBe(1);
    expect(base.quality.heldOut?.accuracyWeighted).toBe(0.2);
    expect(base.quality.heldOut?.estimatedRequestUsdWeighted).toBeCloseTo(0.05);
    const markdown = compareScoreboards(base, head, { relativeOnly: true });
    expect(markdown).toContain('| quality.heldOut.accuracyWeighted | +350.00% | better |');
    expect(markdown).toContain(
      '| quality.heldOut.estimatedRequestUsdWeighted | -30.00% | better |'
    );
    expect(markdown).toContain('| quality.heldOut.p50LatencyMsWeighted | -70.00% | better |');
    expect(pricedTable.routes['implementation/code_generation'][0].model).toBe('fixture/first');
  });

  it('skips routes without held-out data for the exact picked variant and renormalizes coverage', () => {
    const summary: OfflineSweepSummary = {
      model: 'fixture/first',
      variant: null,
      routeKey: 'implementation/code_generation',
      split: 'heldOut',
      accuracy: 0.7,
      cases: 10,
      avgCostUsd: 0.03,
      p50LatencyMs: 500,
    };
    const sweep: OfflineSweep = {
      startedAt: now.toISOString(),
      truncated: true,
      costUsd: 0,
      graderCostUsd: 0,
      pairs: [],
      summaries: [
        summary,
        { ...summary, model: 'fixture/third', variant: 'high', routeKey: 'debugging/bug_fixing' },
      ],
    };
    const result = build(
      table,
      prod({ 'implementation/code_generation': 0.25, 'debugging/bug_fixing': 0.75 }),
      null,
      { sweep }
    );
    expect(result.quality.heldOut).toEqual({
      accuracyWeighted: 0.7,
      estimatedRequestUsdWeighted: 0.03,
      p50LatencyMsWeighted: 500,
      routes: 1,
    });
    expect(
      build(table, null, null, { sweep: { ...sweep, summaries: [] } }).quality.heldOut
    ).toEqual({
      accuracyWeighted: null,
      estimatedRequestUsdWeighted: null,
      p50LatencyMsWeighted: null,
      routes: 0,
    });
    const missingCost = build(table, null, null, {
      sweep: { ...sweep, summaries: [{ ...summary, avgCostUsd: null }] },
    });
    expect(missingCost.quality.heldOut?.accuracyWeighted).toBe(0.7);
    expect(missingCost.quality.heldOut?.estimatedRequestUsdWeighted).toBeNull();
    expect(missingCost.quality.heldOut?.routes).toBe(1);
    const infraOnly: OfflineSweepSummary = {
      ...summary,
      accuracy: null,
      cases: 0,
      errors: 2,
      avgCostUsd: null,
      p50LatencyMs: null,
    };
    expect(
      build(table, null, null, { sweep: { ...sweep, summaries: [infraOnly] } }).quality.heldOut
        ?.routes
    ).toBe(0);
    const rebuilt = build(table, null, null, {
      sweep: {
        ...sweep,
        summaries: [infraOnly, { ...infraOnly, split: 'train' }],
      },
      rebuildFromSweep: true,
    });
    expect(rebuilt.quality.benchmarkAccuracyWeighted).toBeNull();
    expect(rebuilt.quality.heldOut?.routes).toBe(0);
  });

  it('retains a graded route when its only training candidate has unknown cost', () => {
    const summary: OfflineSweepSummary = {
      model: 'fixture/first',
      variant: null,
      routeKey: 'implementation/code_generation',
      split: 'train',
      accuracy: 0.7,
      cases: 10,
      avgCostUsd: null,
      p50LatencyMs: 100,
    };
    const sweep: OfflineSweep = {
      startedAt: now.toISOString(),
      truncated: false,
      costUsd: 0,
      graderCostUsd: 0,
      pairs: [],
      summaries: [summary, { ...summary, split: 'heldOut' }],
    };
    const result = build(table, null, null, { sweep, rebuildFromSweep: true });
    expect(result.quality.benchmarkAccuracyWeighted).toBe(0.7);
    expect(result.cost.benchmarkPerTaskUsdWeighted).toBe(0);
    expect(result.quality.heldOut?.accuracyWeighted).toBe(0.7);
    expect(result.quality.heldOut?.estimatedRequestUsdWeighted).toBeNull();
    expect(result.quality.heldOut?.p50LatencyMsWeighted).toBe(100);
    expect(result.quality.heldOut?.routes).toBe(1);
  });

  it('lets unknown-cost candidates compete at the route maximum known production-cost estimate', () => {
    const summary: OfflineSweepSummary = {
      model: 'fixture/known',
      variant: null,
      routeKey: 'implementation/code_generation',
      split: 'train',
      accuracy: 0.7,
      cases: 100,
      avgCostUsd: 0.1,
      p50LatencyMs: 100,
    };
    const sweep: OfflineSweep = {
      startedAt: now.toISOString(),
      truncated: false,
      costUsd: 0,
      graderCostUsd: 0,
      pairs: [],
      summaries: [
        summary,
        { ...summary, model: 'fixture/unknown', accuracy: 1, avgCostUsd: null },
        {
          ...summary,
          model: 'fixture/unknown',
          split: 'heldOut',
          accuracy: 0.9,
          avgCostUsd: null,
        },
      ],
    };
    const pricing = {
      'fixture/known': {
        promptUsdPerToken: 0.02,
        completionUsdPerToken: 0.02,
        cacheReadUsdPerToken: null,
      },
      'fixture/unknown': {
        promptUsdPerToken: 0.001,
        completionUsdPerToken: 0.001,
        cacheReadUsdPerToken: null,
      },
    };
    const result = build(table, null, null, {
      sweep,
      pricing,
      costProfile: { uncachedInputTokens: 10, cachedInputTokens: 0 },
      rebuildFromSweep: true,
    });
    expect(result.quality.benchmarkAccuracyWeighted).toBe(1);
    expect(result.cost.estimatedRequestUsdWeighted).toBeCloseTo(0.3);
    expect(result.cost.benchmarkPerTaskUsdWeighted).toBeCloseTo(0.29);
    expect(result.quality.heldOut?.accuracyWeighted).toBe(0.9);
    expect(result.quality.heldOut?.estimatedRequestUsdWeighted).toBeNull();
    expect(result.quality.heldOut?.routes).toBe(1);
  });

  it('uses uniform table-route weights when production route mix is empty', () => {
    expect(build(table, prod({}))).toEqual(build(table));
  });

  it('carries aggregate shadow metrics into the scoreboard', () => {
    const metrics = prod({});
    metrics.shadow = {
      observedDecisions: 4,
      differsRate: 0.25,
      outcomesByDecidedModel: {
        'fixture/first': {
          requests: 3,
          errorRate: 1 / 3,
          abortRate: 0,
          inputTokensPerRequest: 20,
          outputTokensPerRequest: 5,
          cacheReadTokensPerRequest: 10,
          costUsdPerRequest: 0.01,
        },
      },
    };
    expect(ScoreboardSchema.parse(build(table, metrics)).shadow).toEqual(metrics.shadow);
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
    expect(markdown).toMatch(/latency: better\ncost: worse\nquality: better\nreliability: flat$/);
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
      /latency: flat\ncost: flat\nquality: flat\nreliability: flat$/
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
    expect(markdown).toMatch(/latency: flat\ncost: better\nquality: flat\nreliability: flat$/);
    expect(() =>
      ReplayMetricsSchema.parse({
        ...replay,
        scenarios: { ...replay.scenarios, cold: { ...scenario, costUsd: -1 } },
      })
    ).toThrow();
  });

  it('compares replay errors on reliability without changing latency direction', () => {
    const scenario = { n: 10, p50: 10, p90: 10, p99: 10, errors: 2 };
    const replay: ReplayMetrics = {
      kind: 'replay',
      target: 'http://localhost:8810',
      startedAt: now.toISOString(),
      sessions: 10,
      scenarios: { cold: scenario, warm_new_turn: scenario, exact_repeat: scenario },
    };
    const base = build(table, null, replay);
    const head = structuredClone(base);
    head.latency.routerOverheadMs.replay = {
      ...replay.scenarios,
      cold: { ...scenario, p50: 5, p90: 5, p99: 5, errors: 4 },
    };
    const markdown = compareScoreboards(base, head, { relativeOnly: false });
    expect(markdown).toContain('| reliability.replay.cold.errors | 2 | 4 | +100.00% | worse |');
    expect(markdown).not.toContain('latency.routerOverheadMs.replay.cold.errors');
    expect(markdown).toMatch(/latency: better\ncost: flat\nquality: flat\nreliability: worse$/);
    expect(compareScoreboards(head, base, { relativeOnly: true })).toContain('reliability: better');
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

describe('estimateClassifiedMetrics', () => {
  it('weights uniform sampled successes and always-logged classified decisions together', () => {
    const result = estimateClassifiedMetrics(
      [
        { n: 2, sampled: true, route: 'sampled', cacheHit: true, cost: 0 },
        { n: 10, sampled: false, route: 'switched', cacheHit: false, cost: 0.02 },
      ],
      2 / 90
    );
    expect(result.routeMix).toEqual({ sampled: 0.9, switched: 0.1 });
    expect(result.cacheHitRate).toBeCloseTo(0.9);
    expect(result.classifierPerRequestUsd).toBeCloseTo(0.002);
  });

  it('retains unsampled classified rows when no successes were sampled', () => {
    expect(
      estimateClassifiedMetrics(
        [{ n: 3, sampled: false, route: 'switched', cacheHit: false, cost: 0.02 }],
        0.01
      )
    ).toEqual({
      routeMix: { switched: 1 },
      cacheHitRate: 0,
      classifierPerRequestUsd: 0.02,
    });
  });

  it('excludes unavailable cache and cost values from their weighted denominators', () => {
    const result = estimateClassifiedMetrics(
      [
        { n: 1, sampled: true, route: 'sampled', cacheHit: null, cost: null },
        { n: 2, sampled: false, route: 'switched', cacheHit: true, cost: 0.01 },
      ],
      0.1
    );
    expect(result.routeMix.sampled).toBeCloseTo(10 / 12);
    expect(result.cacheHitRate).toBe(1);
    expect(result.classifierPerRequestUsd).toBe(0.01);
  });

  it('uses observed counts unchanged when all successes are sampled', () => {
    const result = estimateClassifiedMetrics(
      [
        { n: 2, sampled: true, route: 'sampled', cacheHit: true, cost: 0 },
        { n: 2, sampled: false, route: 'switched', cacheHit: false, cost: 0.02 },
      ],
      1
    );
    expect(result.routeMix).toEqual({ sampled: 0.5, switched: 0.5 });
    expect(result.cacheHitRate).toBe(0.5);
    expect(result.classifierPerRequestUsd).toBe(0.01);
  });

  it('handles disabled success sampling without division by zero', () => {
    expect(
      estimateClassifiedMetrics(
        [{ n: 2, sampled: false, route: 'switched', cacheHit: false, cost: 0.02 }],
        0
      )
    ).toEqual({
      routeMix: { switched: 1 },
      cacheHitRate: 0,
      classifierPerRequestUsd: 0.02,
    });
  });

  it('returns unavailable metrics and an empty mix when no classified decisions were logged', () => {
    expect(estimateClassifiedMetrics([], 0.01)).toEqual({
      routeMix: {},
      cacheHitRate: null,
      classifierPerRequestUsd: null,
    });
  });
});
