import { describe, expect, it } from 'vitest';
import type {
  BenchmarkDeciderModel,
  BenchmarkModelSummary,
  ComplexityLabels,
  RoutingTable,
  TaxonomyRouteKey,
} from '@kilocode/auto-routing-contracts';
import { RoutingTableSchema, TAXONOMY_ROUTE_KEYS } from '@kilocode/auto-routing-contracts';
import {
  buildEffortByComplexity,
  buildRoutingTable,
  computeRegistryRoutingTableVersion,
  MIN_COMPLEXITY_CASES,
} from './routing-table-builder';
import type { OfflineSweep } from './scoreboard/schema';

const DECIDER_MODELS: BenchmarkDeciderModel[] = [
  { id: 'model/cheap', variant: null, reasoningEffort: null },
  { id: 'model/value', variant: 'medium', reasoningEffort: null },
  { id: 'model/weak', variant: null, reasoningEffort: null },
];

function summary(
  model: string,
  routeKey: TaxonomyRouteKey | '*',
  accuracy: number,
  avgCostUsd: number | null = 0.001
): BenchmarkModelSummary {
  return {
    model,
    variant: model === 'model/value' ? 'medium' : null,
    routeKey,
    accuracy,
    avgCostUsd,
    avgLatencyMs: 500,
    p50LatencyMs: 450,
    p95LatencyMs: null,
    cases: 10,
    errors: 0,
    timeouts: 0,
    routeAccuracy: null,
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

describe('buildEffortByComplexity', () => {
  const route = 'implementation/code_generation';
  const routes: RoutingTable['routes'] = {
    [route]: ['low', 'high'].map(variant => ({
      model: 'model/shared',
      variant,
      accuracy: 1,
      avgCostUsd: 0.1,
      meetsThreshold: true,
    })),
  };
  const labels: ComplexityLabels = Object.fromEntries(
    ['low', 'high'].flatMap(bucket =>
      Array.from({ length: MIN_COMPLEXITY_CASES }, (_, i) => [`${bucket}-${i}`, bucket])
    )
  ) as ComplexityLabels;
  function pairs(highCases = MIN_COMPLEXITY_CASES): OfflineSweep['pairs'] {
    return ['low', 'high'].map(variant => ({
      model: 'model/shared',
      variant,
      results: ['low', 'high'].flatMap(bucket =>
        Array.from({ length: bucket === 'high' ? highCases : MIN_COMPLEXITY_CASES }, (_, i) => ({
          caseId: `${bucket}-${i}`,
          rep: 0,
          routeKey: route,
          split: 'train' as const,
          score: 1,
          costUsd: variant === bucket ? 0.01 : 1,
          graderCostUsd: 0,
          latencyMs: 100,
          error: null,
        }))
      ),
    }));
  }

  it('ranks variants independently for each measured complexity bucket', () => {
    expect(buildEffortByComplexity(routes, pairs(), labels, 0.9)).toEqual({
      [route]: { 'model/shared': { low: 'low', medium: 'low', high: 'high' } },
    });
  });

  it('uses the route-level variant for sparse and absent buckets', () => {
    const mapping = buildEffortByComplexity(routes, pairs(MIN_COMPLEXITY_CASES - 1), labels, 0.9);
    expect(mapping[route]?.['model/shared']).toEqual({ low: 'low', medium: 'low', high: 'low' });
  });

  it('ignores unlabeled and infrastructure-error cases when deciding bucket coverage', () => {
    expect(buildEffortByComplexity(routes, pairs(), {}, 0.9)[route]?.['model/shared']?.high).toBe(
      'low'
    );
    const failed = pairs().map(pair => ({
      ...pair,
      results: pair.results.map(result =>
        result.caseId.startsWith('high-')
          ? { ...result, error: 'OpenRouter returned HTTP 503' }
          : result
      ),
    }));
    expect(
      buildEffortByComplexity(routes, failed, labels, 0.9)[route]?.['model/shared']?.high
    ).toBe('low');
  });

  it('does not count repetitions as independent cases or train on held-out scores', () => {
    const repeated = pairs(1).map(pair => ({
      ...pair,
      results: pair.results.flatMap(result =>
        Array.from({ length: MIN_COMPLEXITY_CASES }, (_, rep) => ({ ...result, rep }))
      ),
    }));
    expect(
      buildEffortByComplexity(routes, repeated, labels, 0.9)[route]?.['model/shared']?.high
    ).toBe('low');
    const heldOut = pairs().map(pair => ({
      ...pair,
      results: pair.results.map(result => ({ ...result, split: 'heldOut' as const })),
    }));
    expect(
      buildEffortByComplexity(routes, heldOut, labels, 0.9)[route]?.['model/shared']?.high
    ).toBe('low');
  });

  it('does not choose pairs missing from the published model candidates', () => {
    const measured = [
      ...pairs(),
      {
        ...pairs()[0],
        variant: 'unpublished',
        results: pairs()[0].results.map(r => ({ ...r, costUsd: 0 })),
      },
    ];
    expect(
      buildEffortByComplexity(routes, measured, labels, 0.9)[route]?.['model/shared']?.high
    ).toBe('high');
  });

  it('preserves null as the selected variant instead of falling back to a named effort', () => {
    const nullRoutes: RoutingTable['routes'] = {
      [route]: [
        {
          model: 'model/shared',
          variant: 'high',
          accuracy: 1,
          avgCostUsd: 1,
          meetsThreshold: true,
        },
        {
          model: 'model/shared',
          variant: null,
          accuracy: 1,
          avgCostUsd: 0.01,
          meetsThreshold: true,
        },
      ],
    };
    const measured = pairs().map(pair => ({
      ...pair,
      variant: pair.variant === 'low' ? null : 'high',
    }));
    expect(
      buildEffortByComplexity(nullRoutes, measured, labels, 0.9)[route]?.['model/shared']?.low
    ).toBeNull();
  });

  it('includes complexity choices in registry table identity', () => {
    const contributors = [{ runId: 'fixture', model: 'model/shared', variant: 'low' }];
    const knobs = { minAccuracy: 0.9, switchCostFactor: 3, bestAccuracySwitchThreshold: 0.05 };
    const base = computeRegistryRoutingTableVersion(contributors, knobs);
    expect(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        effortByComplexity: buildEffortByComplexity(routes, pairs(), labels, 0.9),
      })
    ).not.toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        effortByComplexity: { [route]: { 'model/shared': { low: null } } },
      })
    ).not.toBe(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        effortByComplexity: { [route]: { 'model/shared': {} } },
      })
    );
  });

  it('attaches learned efforts when building the full routing table', () => {
    const built = buildRoutingTable({
      version: 'fixture-complexity',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.9,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: [
        { id: 'model/shared', variant: 'low', reasoningEffort: null },
        { id: 'model/shared', variant: 'high', reasoningEffort: null },
      ],
      summaries: TAXONOMY_ROUTE_KEYS.flatMap(routeKey =>
        ['low', 'high'].map(variant => ({
          ...summary('model/shared', routeKey, 1, variant === 'low' ? 0.1 : 1),
          variant,
        }))
      ),
      perCaseResults: pairs(),
      complexityLabels: labels,
    });
    expect(built.effortByComplexity?.[route]?.['model/shared']?.high).toBe('high');
  });
});

describe('production-cost table version', () => {
  it('includes first-token measurements in the version independent of summary order', () => {
    const contributors = [{ runId: 'synthetic-run', model: 'model/cheap', variant: null }];
    const knobs = { minAccuracy: 0.9, switchCostFactor: 3, bestAccuracySwitchThreshold: 0.05 };
    const summaries = [
      { ...summary('model/cheap', TAXONOMY_ROUTE_KEYS[0], 1), p50TtftMs: 100 },
      { ...summary('model/cheap', TAXONOMY_ROUTE_KEYS[1], 1), p50TtftMs: null },
    ];
    const base = computeRegistryRoutingTableVersion(contributors, { ...knobs, summaries });
    expect(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        summaries: [...summaries].reverse(),
      })
    ).toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        summaries: summaries.map(s => ({ ...s, p50TtftMs: 200 })),
      })
    ).not.toBe(base);
  });

  it('republishes when the profile, horizon or model prices change', () => {
    const contributors = [{ runId: 'synthetic-run', model: 'synthetic/model', variant: null }];
    const knobs = { minAccuracy: 0.9, switchCostFactor: 3, bestAccuracySwitchThreshold: 0.05 };
    const base = computeRegistryRoutingTableVersion(contributors, knobs);
    expect(
      computeRegistryRoutingTableVersion(contributors, { ...knobs, productionTokenProfile: null })
    ).toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        productionTokenProfile: { uncachedInputTokens: 20, cachedInputTokens: 80 },
      })
    ).not.toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, { ...knobs, switchHorizonTurns: 4 })
    ).not.toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, { ...knobs, lowConfidenceThreshold: 0.8 })
    ).not.toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, { ...knobs, lowConfidenceThreshold: null })
    ).toBe(base);
    expect(
      computeRegistryRoutingTableVersion(contributors, {
        ...knobs,
        prices: new Map([
          [
            'synthetic/model',
            { promptUsdPerToken: 0.002, completionUsdPerToken: 0.003, cacheReadUsdPerToken: null },
          ],
        ]),
      })
    ).not.toBe(base);
  });
});

describe('buildRoutingTable', () => {
  it('publishes prompt-cost ranking and the production switching settings', () => {
    const params = {
      version: 'synthetic-production-cost',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.9,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: TAXONOMY_ROUTE_KEYS.flatMap(routeKey => [
        summary('model/cheap', routeKey, 1, 0.01),
        summary('model/value', routeKey, 1, 0.02),
      ]),
      prices: new Map([
        [
          'model/cheap',
          { promptUsdPerToken: 0.002, completionUsdPerToken: 0.003, cacheReadUsdPerToken: 0.001 },
        ],
        [
          'model/value',
          { promptUsdPerToken: 0.0002, completionUsdPerToken: 0.003, cacheReadUsdPerToken: 0.0001 },
        ],
      ]),
    };
    const route = 'implementation/code_generation';
    expect(buildRoutingTable(params).routes[route]?.[0]?.model).toBe('model/cheap');
    const productionTokenProfile = { uncachedInputTokens: 20, cachedInputTokens: 80 };
    const table = buildRoutingTable({
      ...params,
      productionTokenProfile,
      switchHorizonTurns: 4,
      lowConfidenceThreshold: 0.8,
    });
    expect(table.routes[route]?.[0]?.model).toBe('model/value');
    expect(table.routes[route]?.[0]?.estimatedRequestCostUsd).toBeCloseTo(0.032);
    expect(table.routes[route]?.[0]?.pricing).toEqual(params.prices.get('model/value'));
    expect(table.productionTokenProfile).toEqual(productionTokenProfile);
    expect(table.switchHorizonTurns).toBe(4);
    expect(table.lowConfidenceThreshold).toBe(0.8);
    expect(table.routes[route]?.[0]?.cases).toBe(10);
  });

  it('ranks equally accurate candidates by their measured sample size', () => {
    const routeKey = 'implementation/code_generation';
    const table = buildRoutingTable({
      version: 'synthetic-wilson',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.95,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: DECIDER_MODELS,
      summaries: summariesForEveryRoute({
        [routeKey]: [
          { ...summary('model/cheap', routeKey, 1), cases: 10 },
          { ...summary('model/value', routeKey, 1), cases: 100 },
        ],
      }),
    });
    expect(table.routes[routeKey]?.map(c => [c.model, c.cases])).toEqual([
      ['model/value', 100],
      ['model/cheap', 10],
    ]);
  });

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

  it('publishes canonical variant-only identities from the run snapshot', () => {
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
    expect(value?.variant).toBe('medium');
    expect(value).not.toHaveProperty('reasoningEffort');

    const cheap = table.routes['implementation/code_generation']?.find(
      c => c.model === 'model/cheap'
    );
    expect(cheap).not.toHaveProperty('reasoningEffort');
    expect(cheap?.variant).toBeNull();
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
    expect(highAcc?.variant).toBe('high');
    expect(lowAcc?.variant).toBe('low');
    expect(highAcc).not.toHaveProperty('reasoningEffort');
    expect(lowAcc).not.toHaveProperty('reasoningEffort');
  });

  it('binds candidates to an exact (model, variant) snapshot match', () => {
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
    expect(a?.variant).toBe('high');
    expect(b?.variant).toBe('medium');
  });

  it('rejects a mismatched effort even when the snapshot has only one model row', () => {
    expect(() =>
      buildRoutingTable({
        version: 'test-run-no-alias-transfer',
        generatedAt: '2026-01-01T00:00:00.000Z',
        minAccuracy: 0.7,
        switchCostFactor: 3,
        bestAccuracySwitchThreshold: 0.05,
        deciderModels: [{ id: 'model/value', variant: 'thinking', reasoningEffort: null }],
        summaries: summariesForEveryRoute(),
      })
    ).toThrow(/no snapshot row/);
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

  it('emits variant for a snapshot entry whose key is outside the effort enum', () => {
    const table = buildRoutingTable({
      version: 'test-run-non-enum-variant',
      generatedAt: '2026-01-01T00:00:00.000Z',
      minAccuracy: 0.7,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      deciderModels: [{ id: 'model/max', variant: 'max', reasoningEffort: null }],
      summaries: TAXONOMY_ROUTE_KEYS.map(routeKey => ({
        ...summary('model/max', routeKey, 0.9, 0.002),
        variant: 'max',
      })),
    });
    const cand = table.routes['implementation/code_generation']?.[0];
    expect(cand).toBeDefined();
    expect(cand?.variant).toBe('max');
    expect(cand).not.toHaveProperty('reasoningEffort');
    // The published artifact must satisfy the contract schema (variant field allowed).
    expect(RoutingTableSchema.parse(table)).toEqual(table);
  });
});
