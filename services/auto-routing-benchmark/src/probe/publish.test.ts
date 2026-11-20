import {
  benchmarkPairKey,
  TAXONOMY_ROUTE_KEYS,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { describe, expect, it } from 'vitest';
import { buildRoutingTable } from '../routing-table-builder';
import type { OfflineSweep } from '../scoreboard/schema';
import { agenticEligibilityView, PROBE_ROUTE_KEYS } from './eligibility';

// A ready pair's provenance run, as the registry hands it to the publisher.
type Pair = { model: string; variant: string | null; accuracy: number };

const agenticRoute = PROBE_ROUTE_KEYS[0]!;
const otherRoute = 'implementation/code_generation';

// The published table must rank at least one candidate per taxonomy route, so the fixture
// measures every route the way a full registry run does.
function summariesOf(pairs: readonly Pair[]) {
  return pairs.flatMap(pair =>
    TAXONOMY_ROUTE_KEYS.map(routeKey => ({
      model: pair.model,
      variant: pair.variant,
      routeKey,
      accuracy: pair.accuracy,
      cases: routeKey === agenticRoute ? 21 : 6,
      avgCostUsd: 0.01,
      avgInputTokens: 1000,
      avgCachedInputTokens: 0,
      avgOutputTokens: 100,
      avgReasoningTokens: 0,
      avgLatencyMs: 1000,
      p50LatencyMs: 1000,
      p95LatencyMs: 1000,
      errors: 0,
      timeouts: 0,
      routeAccuracy: null,
      runId: `${pair.model}-run`,
    }))
  );
}

function caseResultsOf(pairs: readonly Pair[]): OfflineSweep['pairs'] {
  return pairs.map(pair => ({
    model: pair.model,
    variant: pair.variant,
    results: [agenticRoute, otherRoute].map(routeKey => ({
      caseId: `${pair.model}-${routeKey}`,
      routeKey,
      rep: 0,
      score: pair.accuracy,
      costUsd: 0.01,
      latencyMs: 1000,
      error: null,
      graderCostUsd: 0,
      split: 'train' as const,
    })),
  }));
}

function build(
  pairs: readonly Pair[],
  active: boolean,
  ineligible: Set<string>,
  previous?: RoutingTable
) {
  const view = agenticEligibilityView({
    active,
    ineligible,
    summaries: summariesOf(pairs),
    perCaseResults: caseResultsOf(pairs),
    ...(previous ? { previousRoutes: previous.routes } : {}),
  });
  const table = buildRoutingTable({
    version: 'test',
    generatedAt: '2026-11-20T00:00:00.000Z',
    minAccuracy: 0.5,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    deciderModels: pairs.map(pair => ({
      id: pair.model,
      variant: pair.variant,
      reasoningEffort: null,
    })),
    summaries: view.summaries,
    perCaseResults: view.perCaseResults,
    fallbackRoutes: view.fallbackRoutes,
  });
  return { table, view };
}

const measured = { model: 'meta/muse-ember', variant: 'high', accuracy: 0.61 };
const unmeasured = { model: 'deepseek/deepseek-v4.1-flash-1017', variant: null, accuracy: 0.93 };

describe('agentic route eligibility after activation', () => {
  it('keeps a pair without probe results off the agentic routes and on every other route', () => {
    const { table, view } = build(
      [measured, unmeasured],
      true,
      new Set([benchmarkPairKey({ model: unmeasured.model, variant: unmeasured.variant })])
    );

    // A route is held only when it has no eligible pair at all; dropping one pair from a
    // route with another candidate is not a hold.
    expect(view.heldRouteKeys).toEqual([]);
    expect(table.routes[agenticRoute]?.map(candidate => candidate.model)).toEqual([measured.model]);
    expect(table.routes[otherRoute]?.map(candidate => candidate.model).toSorted()).toEqual(
      [measured.model, unmeasured.model].toSorted()
    );
  });

  it('publishes probe-scored accuracies once every pair is measured', () => {
    const { table, view } = build([measured, unmeasured], true, new Set());
    expect(view.heldRouteKeys).toEqual([]);
    const ranked = table.routes[agenticRoute] ?? [];
    // Higher accuracy first: the freshly measured pair outranks the earlier one.
    expect(ranked.map(candidate => [candidate.model, candidate.accuracy])).toEqual([
      [unmeasured.model, 0.93],
      [measured.model, 0.61],
    ]);
  });

  it('keeps the live candidates of an agentic route with no eligible pair', () => {
    const before = build([measured, unmeasured], false, new Set()).table;
    const after = build(
      [measured, unmeasured],
      true,
      new Set([
        benchmarkPairKey({ model: measured.model, variant: measured.variant }),
        benchmarkPairKey({ model: unmeasured.model, variant: unmeasured.variant }),
      ]),
      before
    );

    expect(after.view.heldRouteKeys).toEqual([...PROBE_ROUTE_KEYS]);
    expect(after.table.routes[agenticRoute]).toEqual(before.routes[agenticRoute]);
    // Other routes still publish from the current build, not the previous table.
    expect(after.table.routes[otherRoute]).toBeDefined();
  });

  it('re-admits a pair on the agentic routes once its probe results land', () => {
    const ineligible = new Set([
      benchmarkPairKey({ model: measured.model, variant: measured.variant }),
    ]);
    const excluded = build([measured, unmeasured], true, ineligible);
    expect(excluded.table.routes[agenticRoute]?.map(candidate => candidate.model)).toEqual([
      unmeasured.model,
    ]);

    const reAdmitted = build([measured, unmeasured], true, new Set());
    expect(
      reAdmitted.table.routes[agenticRoute]?.map(candidate => candidate.model).toSorted()
    ).toEqual([measured.model, unmeasured.model].toSorted());
  });

  it('changes nothing before activation', () => {
    const { table, view } = build(
      [measured, unmeasured],
      false,
      new Set([benchmarkPairKey({ model: unmeasured.model, variant: unmeasured.variant })])
    );
    expect(view.heldRouteKeys).toEqual([]);
    expect(table.routes[agenticRoute]?.map(candidate => candidate.model).toSorted()).toEqual(
      [measured.model, unmeasured.model].toSorted()
    );
  });
});
