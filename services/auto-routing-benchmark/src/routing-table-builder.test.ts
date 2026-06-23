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
      runId: 'test-run-1',
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
      runId: 'test-run-nocost',
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
      runId: 'test-run-4',
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

  it('throws when any taxonomy route has no candidates', () => {
    expect(() =>
      buildRoutingTable({
        runId: 'test-run-missing-route',
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
      runId: 'test-run-classifier-summary',
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
