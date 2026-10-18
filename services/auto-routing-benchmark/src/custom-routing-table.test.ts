import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxonomyRouteKey } from '@kilocode/auto-routing-contracts';
import { TAXONOMY_ROUTE_KEYS } from '@kilocode/auto-routing-contracts';
import type * as DbModule from './db';
import type { BenchmarkModelSummaryWithRun } from './db';
import {
  buildCustomRoutingTable,
  computeRegistryRoutingTableVersion,
} from './routing-table-builder';

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    listReadyCurrentProfilesForEntries: vi.fn(),
    getSummariesForRuns: vi.fn(),
    getRoutingCaseResultsForEntries: vi.fn(),
  };
});

import {
  getRoutingCaseResultsForEntries,
  getSummariesForRuns,
  listReadyCurrentProfilesForEntries,
} from './db';
import { assembleCustomRoutingTable } from './custom-routing-table';
import { computeEngineIdentity } from './run';

function summary(
  model: string,
  variant: string | null,
  routeKey: TaxonomyRouteKey,
  accuracy = 0.9,
  avgCostUsd: number | null = 0.001,
  runId = 'run-default'
): BenchmarkModelSummaryWithRun {
  return {
    model,
    variant,
    routeKey,
    accuracy,
    avgCostUsd,
    avgLatencyMs: 100,
    p50LatencyMs: 90,
    p95LatencyMs: 120,
    cases: 5,
    errors: 0,
    timeouts: 0,
    routeAccuracy: null,
    runId,
  };
}

describe('buildCustomRoutingTable', () => {
  const base = {
    generatedAt: '2026-06-01T00:00:00.000Z',
    minAccuracy: 0.7,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
  };

  it('publishes sample-size ranking and confidence settings for sparse custom tables', () => {
    const routeKey = 'implementation/code_generation';
    const table = buildCustomRoutingTable({
      ...base,
      lowConfidenceThreshold: 0.8,
      readyEntries: [
        { entry: { model: 'vendor/small', variant: null }, runId: 'run-small' },
        { entry: { model: 'vendor/large', variant: null }, runId: 'run-large' },
      ],
      summaries: [
        { ...summary('vendor/small', null, routeKey, 1, 0.001, 'run-small'), cases: 10 },
        { ...summary('vendor/large', null, routeKey, 1, 0.001, 'run-large'), cases: 100 },
      ],
    });
    expect(table?.lowConfidenceThreshold).toBe(0.8);
    expect(table?.routes[routeKey]?.map(c => [c.model, c.cases])).toEqual([
      ['vendor/large', 100],
      ['vendor/small', 10],
    ]);
  });

  it('assembles two variants of one model as distinct candidates with variant', () => {
    const readyEntries = [
      { entry: { model: 'vendor/m', variant: 'xhigh' }, runId: 'run-x' },
      { entry: { model: 'vendor/m', variant: 'max' }, runId: 'run-m' },
    ];
    const routeKey = 'implementation/code_generation' as TaxonomyRouteKey;
    const summaries = [
      summary('vendor/m', 'xhigh', routeKey, 0.9, 0.002, 'run-x'),
      summary('vendor/m', 'max', routeKey, 0.85, 0.001, 'run-m'),
    ];
    const table = buildCustomRoutingTable({ ...base, readyEntries, summaries });
    expect(table).not.toBeNull();
    const cands = table!.routes[routeKey]!;
    expect(cands).toHaveLength(2);
    expect(cands.map(c => c.variant).sort()).toEqual(['max', 'xhigh']);
    expect(cands.every(c => c.reasoningEffort === undefined)).toBe(true);
  });

  it('omits routes with no graded candidates', () => {
    const readyEntries = [{ entry: { model: 'vendor/m', variant: null }, runId: 'run-1' }];
    const onlyOneRoute = 'implementation/code_generation' as TaxonomyRouteKey;
    const summaries = [summary('vendor/m', null, onlyOneRoute, 0.9, 0.001, 'run-1')];
    const table = buildCustomRoutingTable({ ...base, readyEntries, summaries });
    expect(table).not.toBeNull();
    expect(Object.keys(table!.routes)).toEqual([onlyOneRoute]);
    for (const key of TAXONOMY_ROUTE_KEYS) {
      if (key !== onlyOneRoute) {
        expect(table!.routes[key]).toBeUndefined();
      }
    }
  });

  it('unready entries contribute nothing; empty → null', () => {
    expect(
      buildCustomRoutingTable({
        ...base,
        readyEntries: [],
        summaries: [summary('vendor/m', null, 'implementation/code_generation')],
      })
    ).toBeNull();
  });

  it('ignores summaries for pairs not in readyEntries (stale/unready)', () => {
    const readyEntries = [{ entry: { model: 'vendor/ready', variant: 'high' }, runId: 'run-r' }];
    const summaries = [
      summary('vendor/ready', 'high', 'implementation/code_generation', 0.9, 0.001, 'run-r'),
      summary('vendor/stale', 'high', 'implementation/code_generation', 0.9, 0.001, 'run-r'),
    ];
    const table = buildCustomRoutingTable({ ...base, readyEntries, summaries });
    const cands = table!.routes['implementation/code_generation']!;
    expect(cands).toHaveLength(1);
    expect(cands[0].model).toBe('vendor/ready');
  });

  it('binds each ready entry to its provenance run only (no cross-run leakage)', () => {
    // R1 measured entry A and also graded B's pair; B is ready on R2 with
    // fresher metrics. Assembly for B must use R2 only — never R1's stale row.
    const routeKey = 'implementation/code_generation' as TaxonomyRouteKey;
    const readyEntries = [
      { entry: { model: 'vendor/a', variant: 'high' }, runId: 'run-r1' },
      { entry: { model: 'vendor/b', variant: 'max' }, runId: 'run-r2' },
    ];
    const summaries = [
      summary('vendor/a', 'high', routeKey, 0.9, 0.002, 'run-r1'),
      // Stale B metrics from R1 (higher accuracy would win if not filtered)
      summary('vendor/b', 'max', routeKey, 0.99, 0.0001, 'run-r1'),
      // True provenance metrics for B from R2
      summary('vendor/b', 'max', routeKey, 0.8, 0.003, 'run-r2'),
    ];
    const table = buildCustomRoutingTable({ ...base, readyEntries, summaries });
    expect(table).not.toBeNull();
    const cands = table!.routes[routeKey]!;
    expect(cands).toHaveLength(2);
    const b = cands.find(c => c.model === 'vendor/b');
    expect(b).toMatchObject({
      model: 'vendor/b',
      variant: 'max',
      accuracy: 0.8,
      avgCostUsd: 0.003,
    });
    expect(table!.version).toMatch(/^registry-[0-9a-f]{8}$/);
    expect(table!.version).toBe(
      computeRegistryRoutingTableVersion(
        [
          { runId: 'run-r1', model: 'vendor/a', variant: 'high' },
          { runId: 'run-r2', model: 'vendor/b', variant: 'max' },
        ],
        { ...base, summaries: [summaries[0], summaries[2]] }
      )
    );
  });

  it('excludes candidates with no cost signal or zero cases', () => {
    const readyEntries = [
      { entry: { model: 'a', variant: null }, runId: 'r1' },
      { entry: { model: 'b', variant: null }, runId: 'r2' },
    ];
    const routeKey = 'implementation/code_generation' as TaxonomyRouteKey;
    const summaries = [
      summary('a', null, routeKey, 0.9, null, 'r1'),
      { ...summary('b', null, routeKey, 0.8, 0.001, 'r2'), cases: 0 },
    ];
    expect(buildCustomRoutingTable({ ...base, readyEntries, summaries })).toBeNull();
  });

  it('produces a deterministic version for identical inputs', () => {
    const readyEntries = [
      { entry: { model: 'm', variant: 'a' }, runId: 'run-1' },
      { entry: { model: 'm', variant: 'b' }, runId: 'run-2' },
    ];
    const summaries = [
      summary('m', 'a', 'implementation/code_generation', 0.9, 0.001, 'run-1'),
      summary('m', 'b', 'implementation/code_generation', 0.9, 0.001, 'run-2'),
    ];
    const t1 = buildCustomRoutingTable({ ...base, readyEntries, summaries });
    const t2 = buildCustomRoutingTable({
      ...base,
      generatedAt: '2099-01-01T00:00:00.000Z',
      readyEntries: [...readyEntries].reverse(),
      summaries: [...summaries].reverse(),
    });
    expect(t1!.version).toBe(t2!.version);
    expect(t1!.version).toMatch(/^registry-[0-9a-f]{8}$/);
  });

  it('computeRegistryRoutingTableVersion is order-independent', () => {
    const a = [
      { runId: 'r1', model: 'm', variant: 'x' as string | null },
      { runId: 'r2', model: 'n', variant: null },
    ];
    const knobs = { minAccuracy: 0.7, switchCostFactor: 3, bestAccuracySwitchThreshold: 0.05 };
    expect(computeRegistryRoutingTableVersion(a, knobs)).toBe(
      computeRegistryRoutingTableVersion([...a].reverse(), knobs)
    );
    // A threshold-only change must produce a different version, or the
    // publisher would skip writing the retuned table.
    expect(computeRegistryRoutingTableVersion(a, { ...knobs, minAccuracy: 0.8 })).not.toBe(
      computeRegistryRoutingTableVersion(a, knobs)
    );
  });

  it('flags only stale entries and versions the table by engine identity', () => {
    const routeKey = 'implementation/code_generation' as TaxonomyRouteKey;
    const params = {
      ...base,
      router: 'frontier' as const,
      engineIdentity: 'frontier:v1:a',
      readyEntries: [
        { entry: { model: 'fresh', variant: null }, runId: 'r1', stale: false },
        { entry: { model: 'old', variant: null }, runId: 'r2', stale: true },
      ],
      summaries: [
        summary('fresh', null, routeKey, 0.9, 0.001, 'r1'),
        summary('old', null, routeKey, 0.9, 0.001, 'r2'),
      ],
    };
    const table = buildCustomRoutingTable(params);
    expect(
      Object.fromEntries(table!.routes[routeKey]!.map(c => [c.model, c.stale ?? false]))
    ).toEqual({ fresh: false, old: true });
    expect(table!.version).toMatch(/^frontier-registry-/);
    expect(
      buildCustomRoutingTable({ ...params, engineIdentity: 'frontier:v2:b' })!.version
    ).not.toBe(table!.version);
  });
});

describe('assembleCustomRoutingTable', () => {
  const config = {
    deciderRepetitions: 1,
    minAccuracy: 0.7,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    lowConfidenceThreshold: 0.8,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRoutingCaseResultsForEntries).mockResolvedValue([]);
  });

  it('returns table null when no ready current profiles', async () => {
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
    const result = await assembleCustomRoutingTable({} as D1Database, config, [
      { model: 'm', variant: 'x' },
    ]);
    expect(result).toEqual({ table: null });
    expect(getSummariesForRuns).not.toHaveBeenCalled();
  });

  it('allows every effort when expanded pairs exceed the model admission limit', async () => {
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
    const pairs = Array.from({ length: 12 }, (_, index) => ({
      model: 'vendor/m',
      variant: `effort-${index}`,
    }));
    await expect(assembleCustomRoutingTable({} as D1Database, config, pairs)).resolves.toEqual({
      table: null,
    });
  });

  it('loads provenance summaries and assembles with current engine filter', async () => {
    const engine = computeEngineIdentity('decider');
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'vendor/m', variant: 'xhigh', run_id: 'run-x' },
      { model: 'vendor/m', variant: 'max', run_id: 'run-m' },
    ]);
    vi.mocked(getSummariesForRuns).mockResolvedValue([
      summary('vendor/m', 'xhigh', 'implementation/code_generation', 0.9, 0.002, 'run-x'),
      summary('vendor/m', 'max', 'implementation/code_generation', 0.8, 0.001, 'run-m'),
    ]);
    const result = await assembleCustomRoutingTable({} as D1Database, config, [
      { model: 'vendor/m', variant: 'xhigh' },
      { model: 'vendor/m', variant: 'max' },
    ]);
    expect(listReadyCurrentProfilesForEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ engineIdentity: engine, repetitions: 1 }),
      expect.any(Array)
    );
    expect(result.table).not.toBeNull();
    expect(getRoutingCaseResultsForEntries).toHaveBeenCalledWith(expect.anything(), [
      { entry: { model: 'vendor/m', variant: 'xhigh' }, runId: 'run-x' },
      { entry: { model: 'vendor/m', variant: 'max' }, runId: 'run-m' },
    ]);
    expect(result.table?.lowConfidenceThreshold).toBe(0.8);
    expect(result.table!.routes['implementation/code_generation']).toHaveLength(2);
  });
});
