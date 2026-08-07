import { describe, expect, it } from 'vitest';
import type {
  BenchmarkDeciderModel,
  BenchmarkModelSummary,
  TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { TAXONOMY_ROUTE_KEYS } from '@kilocode/auto-routing-contracts';
import { buildRoutingTable } from './routing-table-builder';

const DECIDER_MODELS: BenchmarkDeciderModel[] = [
  { id: 'model/cheap', reasoningEffort: null },
  { id: 'model/value', reasoningEffort: 'medium' },
  { id: 'model/weak', reasoningEffort: null },
];

function summary(
  model: string,
  routeKey: TaxonomyRouteKey | '*',
  accuracy: number,
  avgCostUsd: number | null = 0.001
): BenchmarkModelSummary {
  return {
    model,
    routeKey,
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

function summariesForEveryRoute(
  overrides: Partial<Record<TaxonomyRouteKey, BenchmarkModelSummary[]>> = {}
): BenchmarkModelSummary[] {
  return TAXONOMY_ROUTE_KEYS.flatMap(
    routeKey =>
      overrides[routeKey] ?? [
        summary('model/cheap', routeKey, 0.7, 0.007),
        summary('model/value', routeKey, 0.9, 0.008),
        summary('model/weak', routeKey, 0.5, 0.001),
      ]
  );
}

describe('buildRoutingTable', () => {
  it('ranks candidates by lowest cost per accuracy for each taxonomy route', () => {
    const table = buildRoutingTable({
      version: 'test-run-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: summariesForEveryRoute(),
    });

    expect(table.routes['implementation/code_generation']?.map(c => c.model)).toEqual([
      'model/value',
      'model/cheap',
      'model/weak',
    ]);
  });

  it('excludes a model whose route summary has no cost signal', () => {
    const routeKey = 'implementation/code_generation';
    const table = buildRoutingTable({
      version: 'test-run-nocost',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: summariesForEveryRoute({
        [routeKey]: [
          summary('model/cheap', routeKey, 0.7, null),
          summary('model/value', routeKey, 0.9, 0.008),
        ],
      }),
    });

    expect(table.routes[routeKey]?.map(c => c.model)).toEqual(['model/value']);
  });

  it('carries reasoningEffort from the run snapshot', () => {
    const table = buildRoutingTable({
      version: 'test-run-4',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: summariesForEveryRoute(),
    });

    const value = table.routes['implementation/code_generation']?.find(
      c => c.model === 'model/value'
    );
    expect(value?.reasoningEffort).toBe('medium');

    const cheap = table.routes['implementation/code_generation']?.find(
      c => c.model === 'model/cheap'
    );
    expect(cheap?.reasoningEffort).toBeNull();
  });

  it('platform table JSON shape has reasoningEffort and no variant key', () => {
    const table = buildRoutingTable({
      version: 'test-run-platform-shape',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: summariesForEveryRoute(),
    });
    const cand = table.routes['implementation/code_generation']?.[0];
    expect(cand).toBeDefined();
    expect(cand).toHaveProperty('reasoningEffort');
    expect(Object.keys(cand ?? {})).not.toContain('variant');
    // Serialize/parse as published artifact would.
    const json = JSON.parse(JSON.stringify(table)) as typeof table;
    const jCand = json.routes['implementation/code_generation']?.[0];
    expect(jCand).toHaveProperty('reasoningEffort');
    expect(jCand && 'variant' in jCand).toBe(false);
  });

  it('two variants of one model appear as distinct candidates with matched efforts', () => {
    const routeKey = 'implementation/code_generation' as const;
    const table = buildRoutingTable({
      version: 'test-run-two-variants',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.5,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: [
        { id: 'model/a', reasoningEffort: 'high' },
        { id: 'model/a', reasoningEffort: 'low' },
      ],
      summaries: TAXONOMY_ROUTE_KEYS.flatMap(rk => {
        if (rk !== routeKey) {
          // Non-focus routes need both pairs so no route is empty and exact
          // (model, variant) matching still binds each summary to its effort.
          return [
            { ...summary('model/a', rk, 0.8, 0.001), variant: 'high' },
            { ...summary('model/a', rk, 0.75, 0.0015), variant: 'low' },
          ];
        }
        return [
          { ...summary('model/a', rk, 0.9, 0.002), variant: 'high' },
          { ...summary('model/a', rk, 0.7, 0.001), variant: 'low' },
        ];
      }),
    });
    const cands = table.routes[routeKey] ?? [];
    expect(cands).toHaveLength(2);
    expect(cands.map(c => c.model)).toEqual(['model/a', 'model/a']);
    // Per-candidate pairing: accuracy 0.9 was measured at high, 0.7 at low.
    // A swapping matcher that only checks the effort set would still fail here.
    const highAcc = cands.find(c => c.accuracy === 0.9);
    const lowAcc = cands.find(c => c.accuracy === 0.7);
    expect(highAcc?.reasoningEffort).toBe('high');
    expect(lowAcc?.reasoningEffort).toBe('low');
    for (const c of cands) {
      expect(Object.keys(c)).not.toContain('variant');
    }
  });

  it('binds reasoningEffort from an exact (model, variant) snapshot match', () => {
    const routeKey = 'implementation/code_generation' as const;
    const table = buildRoutingTable({
      version: 'test-run-exact-pair',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.5,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: [
        { id: 'model/a', reasoningEffort: 'high' },
        { id: 'model/a', reasoningEffort: 'low' },
        { id: 'model/b', reasoningEffort: 'medium' },
      ],
      summaries: TAXONOMY_ROUTE_KEYS.flatMap(rk => [
        { ...summary('model/a', rk, 0.9, 0.002), variant: 'high' },
        { ...summary('model/b', rk, 0.8, 0.003), variant: 'medium' },
      ]),
    });
    const a = table.routes[routeKey]?.find(c => c.model === 'model/a');
    const b = table.routes[routeKey]?.find(c => c.model === 'model/b');
    expect(a?.reasoningEffort).toBe('high');
    expect(b?.reasoningEffort).toBe('medium');
  });

  it('legacy single-row snapshot binds when summary omits variant', () => {
    const table = buildRoutingTable({
      version: 'test-run-legacy-single',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: summariesForEveryRoute(),
    });
    const value = table.routes['implementation/code_generation']?.find(
      c => c.model === 'model/value'
    );
    expect(value?.reasoningEffort).toBe('medium');
  });

  it('throws when multiple snapshot rows exist and none matches the summary pair', () => {
    expect(() =>
      buildRoutingTable({
        version: 'test-run-ambiguous-snapshot',
        generatedAt: '2026-01-01T00:00:00.000Z',
        minAccuracy: 0.5,
        switchCostFactor: 3,
        bestAccuracySwitchThreshold: 0.05,
        deciderModels: [
          { id: 'model/a', reasoningEffort: 'high' },
          { id: 'model/a', reasoningEffort: 'low' },
        ],
        // Summary has no variant and two snapshot rows → cannot bind safely.
        summaries: TAXONOMY_ROUTE_KEYS.map(rk => summary('model/a', rk, 0.9, 0.002)),
      })
    ).toThrow(/no snapshot row for model model\/a/);
  });

  it('throws when any taxonomy route has no candidates', () => {
    expect(() =>
      buildRoutingTable({
        version: 'test-run-missing-route',
        generatedAt: '2026-01-01T00:00:00.000Z',
        minAccuracy: 0.7,
        switchCostFactor: 3,
        bestAccuracySwitchThreshold: 0.05,
        deciderModels: DECIDER_MODELS,
        summaries: summariesForEveryRoute({ 'implementation/code_generation': [] }),
      })
    ).toThrow();
  });

  it('ignores classifier-style * route summaries', () => {
    const table = buildRoutingTable({
      version: 'test-run-classifier-summary',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: [...summariesForEveryRoute(), summary('model/value', '*', 1, 0.0001)],
    });

    expect(table.routes['implementation/code_generation']).toHaveLength(3);
  });
});
