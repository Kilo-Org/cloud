import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  benchmarkPairKey,
  TAXONOMY_ROUTE_KEYS,
  taxonomyRouteKey,
  type AutoRouter,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { PROBE_CASES } from './datasets/probe-cases';
import { getLatestRoutingTable, replaceConfig } from './db';
import { ACTIVE_MEASUREMENT_REVISION, PROBE_REVISION } from './measurement-revision';
import { PROBE_ROUTE_KEYS, pairsMissingProbeResults } from './probe/eligibility';
import { computeEngineIdentity, publishPlatformRoutingTable } from './run';

// The hold's promise: at `ACTIVE_MEASUREMENT_REVISION` 2 the platform table ranks exactly the
// pairs it ranked before revision 3 was activated, on every route, whatever revision-3 work
// an earlier deploy left in flight. Revision 3's cases, grading and stored results all stay
// defined; only the activation is off.

const ROUTER: AutoRouter = 'efficient';
// Two agentic pairs whose provenance is revision 2 and so hold no probe results, one pair
// the activation re-measured at revision 3 (complete probes), and Ember: failed at rep 3,
// ready at rep 1.
const UNMEASURED = ['vendor/unmeasured-a', 'vendor/unmeasured-b'] as const;
const MEASURED = 'vendor/remeasured';
const EMBER = 'meta/muse-ember';

const catalogFetch = vi.fn<typeof fetch>(async () =>
  Response.json({
    data: [...UNMEASURED, MEASURED, EMBER].map(id => ({
      id,
      pricing: { prompt: '0.000003', completion: '0.000006' },
    })),
  })
);

describe('platform publish under the revision-2 hold (migrated SQLite)', () => {
  let sqlite: DatabaseSync;
  let env: Env;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    env = {
      BENCH_DB: sqliteD1(sqlite),
      AUTO_ROUTING_CONFIG: { delete: vi.fn(), put: vi.fn() },
      KILO_WEB_API_BASE_URL: 'https://app.test',
    } as unknown as Env;
  });

  function insertRun(id: string, measurementRevision: number) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, completed_at,
          min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity,
          measurement_revision)
         VALUES (?, ?, 'decider', 'platform', 'completed', '2026-11-20T00:00:00.000Z',
          '2026-11-20T01:00:00.000Z', 0.7, 3, 0, 3, ?, ?)`
      )
      .run(id, ROUTER, computeEngineIdentity('decider', ROUTER), measurementRevision);
  }

  /** A ready pair, its provenance run, and one summary per taxonomy route. */
  function seedPair(
    model: string,
    {
      runId,
      measurementRevision,
      probes,
      variant = '',
      repetitions = 3,
      accuracy = 0.9,
    }: {
      runId: string;
      measurementRevision: number;
      probes: boolean;
      variant?: string;
      repetitions?: number;
      accuracy?: number;
    }
  ) {
    insertRun(runId, measurementRevision);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, '2026-11-20', '2026-11-20', '2026-11-20', 1, 0)
         ON CONFLICT (router, model, variant, engine_identity, repetitions) DO UPDATE SET
           status = excluded.status, run_id = excluded.run_id,
           requested_at = excluded.requested_at, updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`
      )
      .run(ROUTER, model, variant, computeEngineIdentity('decider', ROUTER), repetitions, runId);
    const summary = sqlite.prepare(
      `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
        avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
       VALUES (?, ?, ?, ?, ?, 0.001, 800, 800, 30, 0, 900, 0)`
    );
    for (const routeKey of TAXONOMY_ROUTE_KEYS)
      summary.run(runId, model, variant, routeKey, accuracy);
    if (!probes) return;
    const probe = sqlite.prepare(
      `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score, latency_ms,
        rep, prompt_revision)
       VALUES (?, ?, ?, ?, ?, 1, 800, 0, ?)`
    );
    for (const probeCase of PROBE_CASES) {
      probe.run(runId, model, variant, probeCase.id, taxonomyRouteKey(probeCase), PROBE_REVISION);
    }
  }

  async function seedRegistry() {
    const models = [...UNMEASURED, MEASURED, EMBER];
    await replaceConfig(
      env.BENCH_DB,
      {
        min_accuracy: 0.7,
        benchmark_user_id: null,
        benchmark_org_id: null,
        updated_at: '2026-11-20T00:00:00.000Z',
        updated_by: null,
      },
      ['classifier/a'],
      models.map(model => ({ model, variant: null, reasoning_effort: null })),
      ROUTER
    );
    const entries = models.map(model => ({
      model,
      pairs: [{ model, variant: null }],
      servingPairs: [],
      resolutionError: null,
    }));
    sqlite
      .prepare(
        `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
         VALUES (?, 'platform', '', 'rev-1', ?, '2026-11-20')`
      )
      .run(ROUTER, JSON.stringify({ entries, previousEntries: [] }));
  }

  /** The pairs a published table serves on a route. */
  async function publishedRanks() {
    await expect(publishPlatformRoutingTable(env, catalogFetch, ROUTER)).resolves.not.toBeNull();
    const published = await getLatestRoutingTable(env.BENCH_DB, ROUTER);
    return Object.fromEntries(
      TAXONOMY_ROUTE_KEYS.map(routeKey => [
        routeKey,
        (published?.table.routes[routeKey] ?? []).map(candidate => ({
          model: candidate.model,
          variant: candidate.variant ?? null,
        })),
      ])
    ) as Record<string, { model: string; variant: string | null }[]>;
  }

  it('ranks the pre-activation candidate set on every agentic route at revision 2', async () => {
    expect(ACTIVE_MEASUREMENT_REVISION).toBe(2);
    expect(PROBE_ROUTE_KEYS).toEqual(
      expect.arrayContaining([
        'agentic_execution/multi_step_execution',
        'agentic_execution/terminal_operations',
        'agentic_execution/tool_usage',
      ])
    );
    await seedRegistry();

    // The pre-activation registry: none of these provenance runs holds a probe result.
    seedPair(UNMEASURED[0], { runId: 'before-a', measurementRevision: 2, probes: false });
    seedPair(UNMEASURED[1], { runId: 'before-b', measurementRevision: 2, probes: false });
    seedPair(MEASURED, { runId: 'before-c', measurementRevision: 2, probes: false });
    const before = await publishedRanks();

    // The 2026-11-20 activation engaged, then the hold: the revision-3 run finalized with
    // probes for one pair only, and the two others keep their revision-2 provenance.
    seedPair(MEASURED, { runId: 'rev-3', measurementRevision: 3, probes: true });
    const after = await publishedRanks();

    for (const routeKey of PROBE_ROUTE_KEYS) {
      // Same candidates in the same order, so no route narrowed and none re-ranked.
      expect(after[routeKey]).toEqual(before[routeKey]);
      // Every ready rep-3 pair is on every agentic route: nothing is dropped for lacking
      // probe results at revision 2.
      expect(after[routeKey]).toHaveLength(3);
      expect(after[routeKey]!.map(candidate => candidate.model).toSorted()).toEqual(
        [...UNMEASURED, MEASURED].toSorted()
      );
    }
    // The control that the fixture exercises the activation branch: at revision 3 those two
    // pairs would be the ones dropped, because their provenance has no probe result.
    const missing = await pairsMissingProbeResults(env.BENCH_DB, {
      entries: [
        { entry: { model: UNMEASURED[0], variant: null }, runId: 'before-a' },
        { entry: { model: UNMEASURED[1], variant: null }, runId: 'before-b' },
        { entry: { model: MEASURED, variant: null }, runId: 'rev-3' },
      ],
      revision: PROBE_REVISION,
    });
    expect([...missing].toSorted()).toEqual(
      [
        benchmarkPairKey({ model: UNMEASURED[0], variant: null }),
        benchmarkPairKey({ model: UNMEASURED[1], variant: null }),
      ].toSorted()
    );
  });

  it('keeps Ember off the table at revision 2: no ready rep-3 profile, only its rep-1 one', async () => {
    await seedRegistry();
    seedPair(UNMEASURED[0], { runId: 'before-a', measurementRevision: 2, probes: false });
    // The re-admitted rep-3 row is still pending in the stalled run, so the pair is not ready.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, platform_requested, user_requested)
         VALUES (?, ?, '', ?, 3, 'pending', NULL, '2026-11-20', '2026-11-20', 1, 0)`
      )
      .run(ROUTER, EMBER, computeEngineIdentity('decider', ROUTER));
    // Its rep-1 provenance is ready, but a rep-1 row is not the current rep-3 identity.
    seedPair(EMBER, {
      runId: 'ember-rep-1',
      measurementRevision: 2,
      probes: false,
      repetitions: 1,
    });

    const ranks = await publishedRanks();
    for (const routeKey of TAXONOMY_ROUTE_KEYS) {
      expect(ranks[routeKey]?.map(candidate => candidate.model)).not.toContain(EMBER);
    }
    const ready = sqlite
      .prepare(
        'SELECT repetitions, status FROM benchmark_profiles WHERE model = ? ORDER BY repetitions'
      )
      .all(EMBER);
    expect(ready).toEqual([
      { repetitions: 1, status: 'ready' },
      { repetitions: 3, status: 'pending' },
    ]);
  });
});
