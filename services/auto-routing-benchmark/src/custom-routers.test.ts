import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PLATFORM_MEASUREMENTS_PATH,
  PlatformMeasurementsResponseSchema,
} from '@kilocode/auto-routing-contracts';
import type {
  BenchmarkConfig,
  ClientCustomRouterEntry,
  CustomRouterBenchmarkContext,
  CustomRoutingTable,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  assembleCustomRouterTable,
  computeCustomRouterReadinessVersion,
  lookupCustomRouterBlockers,
  lookupCustomRouterStatuses,
} from './custom-routers';
import { DECIDER_CASES } from './datasets/decider-cases';
import { computeEngineIdentity } from './run';
import { app } from './index';

const CONFIG: BenchmarkConfig = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  classifierModels: ['typesafe/jev-1.13'],
  deciderModels: [{ id: 'vendor/platform' }],
  minAccuracy: 0.7,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  updatedAt: null,
  updatedBy: null,
};

const ENGINE = computeEngineIdentity('decider', 'efficient');
const OLD_ENGINE = 'efficient:v0:old';
const ROUTE = 'implementation/code_generation';
const LOCAL = 'client:ollama/qwen3:32b';

const localModel: ClientCustomRouterEntry = {
  kind: 'client',
  provider: 'ollama',
  model: 'qwen3:32b',
  variants: ['low'],
  capabilities: {
    contextLength: 32_768,
    inputModalities: ['text'],
    toolCall: true,
    reasoning: true,
  },
  pricing: null,
};

const clientOnly: CustomRouterBenchmarkContext = {
  ownerType: 'user',
  ownerId: 'user-1',
  baseRouter: 'efficient',
  entries: [localModel],
  clientEvalEntryKeys: [LOCAL],
};

const catalogFetch: typeof fetch = async () =>
  Response.json({
    data: [{ id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } }],
  });

const withGateway: CustomRouterBenchmarkContext = {
  ...clientOnly,
  entries: [localModel, { kind: 'gateway', model: 'vendor/gw' }],
};

const source = {
  catalogEnv: { KILO_WEB_API_BASE_URL: 'https://app.test' },
  fetchImpl: catalogFetch,
  now: new Date('2026-10-16T12:00:00.000Z'),
};

function summary(model: string, variant: string | null, accuracy: number) {
  return {
    model,
    variant,
    routeKey: ROUTE,
    accuracy,
    avgCostUsd: 0,
    avgLatencyMs: 900,
    p50LatencyMs: 900,
    p95LatencyMs: 1200,
    cases: 20,
    errors: 0,
    timeouts: 0,
    routeAccuracy: null,
  };
}

describe('custom router tables and statuses (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  function clientProfile(row: {
    id: string;
    engine?: string;
    accuracy: number;
    updatedAt: string;
    ownerId?: string;
    variant?: string;
    status?: 'pending' | 'ready' | 'failed';
    results?: number;
  }) {
    sqlite
      .prepare(
        `INSERT INTO client_profiles (id, owner_type, owner_id, router, entry_kind, provider, model,
          variant, engine_identity, repetitions, status, results, accuracy, route_summaries,
          created_at, updated_at)
         VALUES (?, 'user', ?, 'efficient', 'client', 'ollama', 'qwen3:32b', ?, ?, 3, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.ownerId ?? 'user-1',
        row.variant ?? 'low',
        row.engine ?? ENGINE,
        row.status ?? 'ready',
        row.results ?? DECIDER_CASES.length * 3,
        row.accuracy,
        JSON.stringify([summary(LOCAL, row.variant ?? 'low', row.accuracy)]),
        row.updatedAt,
        row.updatedAt
      );
  }

  function platformProfile(row: {
    engine: string;
    status: 'pending' | 'ready';
    runId: string | null;
    accuracy?: number;
  }) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', '', ?, 3, ?, ?, '2026-10-01', '2026-10-01', '2026-10-01', 0, 1)`
      )
      .run(row.engine, row.status, row.runId);
    if (row.runId && row.accuracy !== undefined) {
      sqlite
        .prepare(
          `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
            avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
           VALUES (?, 'vendor/gw', '', ?, ?, 0.001, 800, 800, 20, 0, 900, 0)`
        )
        .run(row.runId, ROUTE, row.accuracy);
    }
  }

  // The run that produced a ready row, as the deployed table and the paid flow write it.
  // `admission_marker` is the durable paid-flow proof; NULL is exactly a legacy measurement.
  function runRow(id: string, admitted: boolean, model = 'vendor/gw') {
    sqlite
      .prepare(
        `INSERT INTO benchmark_runs (id, router, kind, purpose, status, started_at, completed_at,
          min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity,
          admission_marker)
         VALUES (?, 'efficient', 'decider', 'platform', 'completed', '2026-10-01', '2026-10-01',
           0.7, 3, 0, 3, ?, ?)`
      )
      .run(id, ENGINE, admitted ? `marker-${id}` : null);
    sqlite
      .prepare(`INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)`)
      .run(id, model);
  }

  const candidates = (table: CustomRoutingTable | null) =>
    (table?.routes[ROUTE] ?? []).map(c => ({
      model: c.model,
      variant: c.variant,
      accuracy: c.accuracy,
      stale: c.stale ?? false,
      estimatedRequestCostUsd: c.estimatedRequestCostUsd,
    }));

  it('emits a current client measurement as a $0 client candidate', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-10' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([
      { model: LOCAL, variant: 'low', accuracy: 0.9, stale: false, estimatedRequestCostUsd: 0 },
    ]);
  });

  it('reports a failing client row with a finite attempt count and its reason', async () => {
    // A genuine failed client row round trip: client_profiles has no attempt counters, class
    // or `unavailable` state, so the reported failure must be one concrete attempt with the
    // row's own reason — never `undefined`/NaN on the wire.
    clientProfile({ id: 'current', accuracy: 0.4, updatedAt: '2026-10-10' });
    sqlite.exec(`UPDATE client_profiles SET status = 'failed',
      failure_reason = 'Client evaluation failed on this device.'`);
    const statuses = await lookupCustomRouterStatuses(db, CONFIG, clientOnly, source);
    const variant = statuses.entries[0]?.variants[0];
    expect(variant).toMatchObject({
      status: 'failed',
      availability: 'unbenchmarked',
      failure: {
        kind: 'retryable',
        attempts: 1,
        failureClass: 'unknown',
        reason: 'Client evaluation failed on this device.',
      },
    });
    expect(Number.isFinite(variant?.failure?.attempts)).toBe(true);
    // The whole payload stays JSON-clean: a NaN would serialize as null.
    expect(JSON.parse(JSON.stringify(variant))).toEqual(JSON.parse(JSON.stringify(variant)));
    expect(JSON.stringify(variant)).not.toContain('null,"attempts"');
  });

  it('serves an older-engine measurement flagged stale', async () => {
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-01' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.8, stale: true })]);
  });

  it('prefers the current measurement over a more recently updated older one', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-01' });
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-09' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.9, stale: false })]);
  });

  it('keeps serving a complete stale measurement while the current one is partial', async () => {
    clientProfile({ id: 'partial', accuracy: 1, updatedAt: '2026-10-12', results: 3 });
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-01' });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.8, stale: true })]);
    const status = await lookupCustomRouterStatuses(db, CONFIG, clientOnly, source);
    expect(status.entries[0]?.variants).toEqual([
      {
        variant: 'low',
        status: 'stale',
        failureReason: null,
        linked: false,
        availability: 'stale',
      },
    ]);
  });

  it('serves a partial current measurement when no stale one exists', async () => {
    clientProfile({ id: 'partial', accuracy: 1, updatedAt: '2026-10-12', results: 3 });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 1, stale: false })]);
  });

  it('uses the newest ready measurement among older engines', async () => {
    clientProfile({
      id: 'older',
      engine: 'efficient:v0:a',
      accuracy: 0.7,
      updatedAt: '2026-09-01',
    });
    clientProfile({
      id: 'newer',
      engine: 'efficient:v0:b',
      accuracy: 0.85,
      updatedAt: '2026-10-01',
    });
    clientProfile({
      id: 'current-pending',
      accuracy: 0,
      updatedAt: '2026-10-15',
      status: 'pending',
    });
    const { table } = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(candidates(table)).toEqual([expect.objectContaining({ accuracy: 0.85, stale: true })]);
  });

  it('never serves another owner or an unlisted variant', async () => {
    clientProfile({ id: 'other', ownerId: 'user-2', accuracy: 0.9, updatedAt: '2026-10-10' });
    clientProfile({ id: 'max', variant: 'max', accuracy: 0.9, updatedAt: '2026-10-10' });
    expect(await assembleCustomRouterTable(db, CONFIG, clientOnly, source)).toEqual({
      table: null,
    });
  });

  it('serves a stale platform gateway measurement beside client candidates', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-10' });
    platformProfile({ engine: OLD_ENGINE, status: 'ready', runId: 'run-old', accuracy: 0.95 });
    platformProfile({ engine: ENGINE, status: 'pending', runId: null });
    const { table } = await assembleCustomRouterTable(db, CONFIG, withGateway, source);
    expect(candidates(table)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: 'vendor/gw', accuracy: 0.95, stale: true }),
        expect.objectContaining({ model: LOCAL, stale: false }),
      ])
    );
    expect(table?.version).toMatch(/^registry-/);
  });

  it('ranks a pinned alias under its logical entry key and reports the target it serves', async () => {
    const alias = '~vendor/latest';
    const pinnedSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.95 });
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [
        {
          kind: 'gateway',
          model: alias,
          servingPin: { model: 'vendor/gw', pinnedAt: '2026-11-20T00:00:00.000Z' },
        },
      ],
      clientEvalEntryKeys: [],
    };
    const result = await assembleCustomRouterTable(db, CONFIG, context, pinnedSource);
    expect(candidates(result.table)).toEqual([
      expect.objectContaining({ model: alias, accuracy: 0.95 }),
    ]);
    expect(result.servingPins).toEqual({ [`gateway:${alias}`]: 'vendor/gw' });
    expect((await lookupCustomRouterStatuses(db, CONFIG, context, pinnedSource)).entries).toEqual([
      {
        key: `gateway:${alias}`,
        variants: [
          {
            variant: null,
            status: 'ready',
            failureReason: null,
            linked: false,
            servingModel: 'vendor/gw',
            availability: 'ready',
          },
        ],
      },
    ]);
  });

  it('serves the live alias target with a fallback warning when the pinned target is gone', async () => {
    const alias = '~vendor/latest';
    const pinnedSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.95 });
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [
        {
          kind: 'gateway',
          model: alias,
          servingPin: { model: 'vendor/gone', pinnedAt: '2026-11-20T00:00:00.000Z' },
        },
      ],
      clientEvalEntryKeys: [],
    };
    const result = await assembleCustomRouterTable(db, CONFIG, context, pinnedSource);
    expect(candidates(result.table)).toEqual([
      expect.objectContaining({ model: alias, accuracy: 0.95 }),
    ]);
    expect(result.servingPins).toBeUndefined();
    expect((await lookupCustomRouterStatuses(db, CONFIG, context, pinnedSource)).entries).toEqual([
      {
        key: `gateway:${alias}`,
        variants: [
          {
            variant: null,
            status: 'ready',
            failureReason: null,
            linked: false,
            servingFallback: true,
            availability: 'ready',
          },
        ],
      },
    ]);
  });

  it('keeps the deployed concrete candidate for an un-pinned legacy alias, and not the alias id', async () => {
    const alias = '~vendor/latest';
    const aliasSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    // The measurement predates the paid flow: its run has no admission marker.
    runRow('run-legacy', false);
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-legacy', accuracy: 0.95 });
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [{ kind: 'gateway', model: alias }],
      clientEvalEntryKeys: [],
    };

    const result = await assembleCustomRouterTable(db, CONFIG, context, aliasSource);
    // Same ranked id and measurement the deployed table published for this pool.
    expect(candidates(result.table)).toEqual([
      expect.objectContaining({ model: 'vendor/gw', accuracy: 0.95, stale: false }),
    ]);
    expect(
      Object.values(result.table?.routes ?? {})
        .flat()
        .map(candidate => candidate.model)
    ).not.toContain(alias);
    expect(result.servingPins).toBeUndefined();
    // Reading the pool wrote no pin and no measurement row.
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM benchmark_profiles WHERE status = 'pending'`).get()
    ).toEqual({ n: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM benchmark_runs`).get()).toEqual({ n: 1 });
  });

  it('ranks an un-pinned alias under its own id only for a paid-flow measurement', async () => {
    const alias = '~vendor/latest';
    const aliasSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    // This run carries the paid-flow admission marker, so its result is the shared paid result.
    runRow('run-paid', true);
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-paid', accuracy: 0.95 });
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [{ kind: 'gateway', model: alias }],
      clientEvalEntryKeys: [],
    };
    const result = await assembleCustomRouterTable(db, CONFIG, context, aliasSource);
    expect(candidates(result.table)).toEqual([
      expect.objectContaining({ model: alias, accuracy: 0.95 }),
    ]);
    // Still no pin: the pool was never asked and never confirmed.
    expect(result.servingPins).toBeUndefined();
  });

  it('lets a no-pin alias observer rank a target another pool just completed', async () => {
    const alias = '~vendor/latest';
    const sharedSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/other', pricing: { prompt: '0.000001', completion: '0.000002' } },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    // Pool A measures the alias target through the paid flow; pool B only has the alias, with a
    // different default entry, and never clicks or pays.
    runRow('run-paid', true);
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-paid', accuracy: 0.95 });
    const plan = await assembleCustomRouterTable(
      db,
      CONFIG,
      {
        ownerType: 'user',
        ownerId: 'user-b',
        baseRouter: 'efficient',
        entries: [
          { kind: 'gateway', model: alias },
          { kind: 'gateway', model: 'vendor/other' },
        ],
        clientEvalEntryKeys: [],
      },
      sharedSource
    );
    // The shared paid result ranks under the alias, which is B's non-default entry. The default
    // (`vendor/other`) has no measurement, so a route that ignored the alias would fall through
    // to an entry this table cannot rank at all.
    expect(candidates(plan.table)).toEqual([
      expect.objectContaining({ model: alias, accuracy: 0.95 }),
    ]);
    expect(
      Object.values(plan.table?.routes ?? {})
        .flat()
        .map(candidate => candidate.model)
    ).not.toContain('vendor/other');
    expect(plan.servingPins).toBeUndefined();
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM benchmark_runs`).get()).toEqual({ n: 1 });
    expect(
      sqlite.prepare(`SELECT COUNT(*) AS n FROM benchmark_profiles WHERE status = 'pending'`).get()
    ).toEqual({ n: 0 });
  });

  it('keeps the duplicate source ready rows in the table version but emits one candidate', async () => {
    const alias = '~vendor/latest';
    const aliasSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    runRow('run-legacy', false);
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-legacy', accuracy: 0.95 });
    const base = {
      ownerType: 'user' as const,
      ownerId: 'user-1',
      baseRouter: 'efficient' as const,
      clientEvalEntryKeys: [] as string[],
    };
    const both = await assembleCustomRouterTable(
      db,
      CONFIG,
      {
        ...base,
        entries: [
          { kind: 'gateway', model: alias },
          { kind: 'gateway', model: 'vendor/gw' },
        ],
      },
      aliasSource
    );
    const aliasOnly = await assembleCustomRouterTable(
      db,
      CONFIG,
      { ...base, entries: [{ kind: 'gateway', model: alias }] },
      aliasSource
    );
    // One emitted row, exactly as deployed published it.
    expect(candidates(both.table)).toEqual([expect.objectContaining({ model: 'vendor/gw' })]);
    // The deployed fingerprint counted the alias and its own concrete entry as two ready
    // contributors, so the pool's version differs from the alias-only pool.
    expect(both.table?.version).not.toBe(aliasOnly.table?.version);
  });

  it('reports a permanently failed resolved pair for add-time validation without writing', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, completed_at, failure_reason, failure_class,
          failure_attempts, model_failure_attempts, first_failed_at, platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', '', ?, 3, 'unavailable', NULL, '2026-10-01',
           '2026-10-01', '2026-10-01', 'does not support tools', 'unsupported', 1, 1,
           '2026-10-01', 0, 1)`
      )
      .run(ENGINE);
    const result = await lookupCustomRouterBlockers(
      db,
      CONFIG,
      { router: 'efficient', models: ['vendor/gw'] },
      source
    );
    expect(result.blocked).toEqual([
      {
        model: 'vendor/gw',
        pair: { model: 'vendor/gw', variant: null },
        failure: expect.objectContaining({ kind: 'permanent', failureClass: 'unsupported' }),
      },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 1 });
  });

  it('reports a user-only permanent pair measured at another repetition count', async () => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, completed_at, failure_reason, failure_class,
          failure_attempts, model_failure_attempts, first_failed_at, platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', '', ?, 1, 'unavailable', NULL, '2026-10-01',
           '2026-10-01', '2026-10-01', 'context too small', 'context_too_small', 1, 0,
           '2026-10-01', 0, 1)`
      )
      .run(ENGINE);
    // `deciderRepetitions` is fixed per router (efficient 3), so the row above sits at a count no
    // live profile uses; the lookup must still find it, and it must not need a queue flag.
    expect(
      await lookupCustomRouterBlockers(
        db,
        CONFIG,
        { router: 'efficient', models: ['vendor/gw'] },
        source
      )
    ).toEqual({
      router: 'efficient',
      blocked: [
        {
          model: 'vendor/gw',
          pair: { model: 'vendor/gw', variant: null },
          failure: expect.objectContaining({
            kind: 'permanent',
            failureClass: 'context_too_small',
          }),
        },
      ],
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 1 });
  });

  it('serves one shared concrete result to two pools, pinned or not', async () => {
    const alias = '~vendor/latest';
    const sharedSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-shared', accuracy: 0.91 });
    const base = {
      ownerType: 'user' as const,
      baseRouter: 'efficient' as const,
      clientEvalEntryKeys: [] as string[],
    };
    // Pool A benchmarked the alias and pinned its target; pool B has the same alias without a pin.
    const pinned = await assembleCustomRouterTable(
      db,
      CONFIG,
      {
        ...base,
        ownerId: 'user-a',
        entries: [
          {
            kind: 'gateway',
            model: alias,
            servingPin: { model: 'vendor/gw', pinnedAt: '2026-11-20T00:00:00.000Z' },
          },
        ],
      },
      sharedSource
    );
    const unpinned = await assembleCustomRouterTable(
      db,
      CONFIG,
      { ...base, ownerId: 'user-b', entries: [{ kind: 'gateway', model: alias }] },
      sharedSource
    );
    // Both pools rank the one ready result: the measurement is global, not per owner.
    expect(candidates(pinned.table)).toEqual([
      expect.objectContaining({ model: alias, accuracy: 0.91 }),
    ]);
    // B has no pin, and this measurement predates the paid flow: it keeps the concrete candidate
    // id the deployed table published for an un-pinned alias.
    expect(candidates(unpinned.table)).toEqual([
      expect.objectContaining({ model: 'vendor/gw', accuracy: 0.91 }),
    ]);
    // Only the pinned pool dispatches the concrete target; the other keeps its live alias.
    expect(pinned.servingPins).toEqual({ [`gateway:${alias}`]: 'vendor/gw' });
    expect(unpinned.servingPins).toBeUndefined();
  });

  it('publishes a partly ready family as soon as one pair finalizes', async () => {
    const alias = '~vendor/latest';
    const multiVariantSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            {
              id: 'vendor/gw',
              opencode: {
                variants: {
                  low: { reasoning: { enabled: true, effort: 'low' } },
                  high: { reasoning: { enabled: true, effort: 'high' } },
                },
              },
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
          ],
        })) as typeof fetch,
    };
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [{ kind: 'gateway', model: alias }],
      clientEvalEntryKeys: [],
    };
    const empty = await computeCustomRouterReadinessVersion(
      db,
      CONFIG,
      context,
      multiVariantSource
    );
    // Nothing ready yet: both variants are queued or failed and neither ranks.
    expect(
      (await assembleCustomRouterTable(db, CONFIG, context, multiVariantSource)).table
    ).toBeNull();

    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', ?, ?, 3, 'ready', ?, '2026-10-01', '2026-10-01',
           '2026-10-01', 0, 1)`
      )
      .run('low', ENGINE, 'run-low');
    sqlite
      .prepare(
        `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
          avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
         VALUES ('run-low', 'vendor/gw', 'low', ?, 0.93, 0.001, 800, 800, 20, 0, 900, 0)`
      )
      .run(ROUTE);
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, completed_at, failure_class, failure_attempts,
          platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', 'high', ?, 3, 'unavailable', NULL, '2026-10-01',
           '2026-10-01', '2026-10-01', 'unsupported', 1, 0, 1)`
      )
      .run(ENGINE);

    // X is final, Y failed: the fingerprint advanced and the ready half already routes everywhere.
    expect(
      await computeCustomRouterReadinessVersion(db, CONFIG, context, multiVariantSource)
    ).not.toBe(empty);
    const ready = await assembleCustomRouterTable(db, CONFIG, context, multiVariantSource);
    // No pin and no admission marker: the deployed concrete candidate id is preserved.
    expect(candidates(ready.table)).toEqual([
      expect.objectContaining({ model: 'vendor/gw', variant: 'low', accuracy: 0.93 }),
    ]);
  });

  it('answers a changed saved policy on the first read without enqueueing work', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.8 });

    // Only the saved policy moves: the ready contributor and every profile row stay untouched.
    const strict: BenchmarkConfig = { ...CONFIG, minAccuracy: 0.95 };
    const lenient: BenchmarkConfig = { ...CONFIG, minAccuracy: 0.7 };
    const before = await assembleCustomRouterTable(db, strict, withGateway, source);
    expect(before.table?.routes[ROUTE] ?? []).toEqual([
      expect.objectContaining({ model: 'vendor/gw', meetsThreshold: false }),
    ]);

    const rowsBefore = sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get();

    const after = await assembleCustomRouterTable(db, lenient, withGateway, source);
    expect(after.table?.routes[ROUTE] ?? []).toEqual([
      expect.objectContaining({ model: 'vendor/gw', meetsThreshold: true }),
    ]);

    // Neither read enqueued or re-measured anything: the policy change alone re-ranked the route.
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual(
      rowsBefore
    );
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_profiles WHERE status = 'pending'").get()
    ).toEqual({ n: 0 });
  });

  it('keeps the readiness fingerprint stable while adding a non-ready profile', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.95 });
    const before = await computeCustomRouterReadinessVersion(db, CONFIG, withGateway, source);
    expect(await computeCustomRouterReadinessVersion(db, CONFIG, withGateway, source)).toBe(before);
    // A request that is queued but not ready changes no ranked candidate, so dependent pools must
    // not rebuild their tables for it.
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, platform_requested, user_requested)
         VALUES ('efficient', 'vendor/gw', 'high', ?, 3, 'pending', NULL, '2026-10-02',
           '2026-10-02', 0, 1)`
      )
      .run(ENGINE);
    expect(await computeCustomRouterReadinessVersion(db, CONFIG, withGateway, source)).toBe(before);
    // A newly ready measurement is a new contributor, so every pool ranking that concrete target
    // sees a new fingerprint and rebuilds without a click.
    sqlite.exec(`UPDATE benchmark_profiles SET status = 'ready', run_id = 'run-gw-new'`);
    expect(await computeCustomRouterReadinessVersion(db, CONFIG, withGateway, source)).not.toBe(
      before
    );
  });

  it('reports measurement availability independently of any billing state', async () => {
    const ready = await lookupCustomRouterStatuses(db, CONFIG, withGateway, source);
    expect(ready.entries[1]?.variants[0]?.availability).toBe('unbenchmarked');
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.95 });
    const measured = await lookupCustomRouterStatuses(db, CONFIG, withGateway, source);
    expect(measured.entries[1]?.variants[0]?.availability).toBe('ready');
    // A retryable failure is not a billing state and stays measurable on a fresh confirmation.
    sqlite.exec(`UPDATE benchmark_profiles SET status = 'failed', run_id = NULL,
      failure_class = 'provider_unavailable', failure_attempts = 1`);
    const retryable = await lookupCustomRouterStatuses(db, CONFIG, withGateway, source);
    expect(retryable.entries[1]?.variants[0]).toMatchObject({
      status: 'failed',
      availability: 'unbenchmarked',
      failure: expect.objectContaining({ kind: 'retryable' }),
    });
    sqlite.exec(`UPDATE benchmark_profiles SET status = 'unavailable',
      failure_class = 'unsupported'`);
    const permanent = await lookupCustomRouterStatuses(db, CONFIG, withGateway, source);
    expect(permanent.entries[1]?.variants[0]).toMatchObject({
      availability: 'permanent_failure',
      failure: expect.objectContaining({ kind: 'permanent' }),
    });
  });

  it('reports legacy serving provenance without adopting it as a pin', async () => {
    const alias = '~vendor/latest';
    const legacySource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.9 });
    sqlite
      .prepare(
        `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot,
          updated_at) VALUES ('efficient', 'user', 'user-1', 'rev-1', ?, '2026-10-01')`
      )
      .run(
        JSON.stringify({
          entries: [
            {
              model: alias,
              pairs: [{ model: 'vendor/gw', variant: null }],
              servingPairs: [{ model: 'vendor/gw', variant: null }],
              resolutionError: null,
            },
          ],
          previousEntries: [],
        })
      );
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [{ kind: 'gateway', model: alias }],
      clientEvalEntryKeys: [],
    };
    const status = await lookupCustomRouterStatuses(db, CONFIG, context, legacySource);
    // Displayed because exactly one concrete model was recorded...
    expect(status.entries[0]).toMatchObject({
      legacyServingTarget: 'vendor/gw',
      legacyServingAmbiguous: false,
    });
    // ...but never adopted: the entry stays unpinned and keeps serving its live alias.
    const entry = context.entries[0];
    expect(entry.kind === 'gateway' ? entry.servingPin : null).toBeUndefined();
    expect(
      (await assembleCustomRouterTable(db, CONFIG, context, legacySource)).servingPins
    ).toBeUndefined();
  });

  it('refuses to name a legacy target when the old snapshot recorded several', async () => {
    const alias = '~vendor/latest';
    const aliasSource = {
      ...source,
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/gw' },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    sqlite
      .prepare(
        `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot,
          updated_at) VALUES ('efficient', 'user', 'user-1', 'rev-1', ?, '2026-10-01')`
      )
      .run(
        JSON.stringify({
          entries: [
            {
              model: alias,
              pairs: [{ model: 'vendor/gw', variant: null }],
              servingPairs: [
                { model: 'vendor/gw', variant: null },
                { model: 'vendor/old', variant: null },
              ],
              resolutionError: null,
            },
          ],
          previousEntries: [],
        })
      );
    const status = await lookupCustomRouterStatuses(
      db,
      CONFIG,
      {
        ownerType: 'user',
        ownerId: 'user-1',
        baseRouter: 'efficient',
        entries: [{ kind: 'gateway', model: alias }],
        clientEvalEntryKeys: [],
      },
      aliasSource
    );
    expect(status.entries[0]).toMatchObject({
      legacyServingTarget: null,
      legacyServingAmbiguous: true,
    });
  });

  it('flags a moved alias under a served pin as needing a re-benchmark', async () => {
    const alias = '~vendor/latest';
    const pinnedSource = {
      ...source,
      // The alias now resolves to a newer target; the saved pin keeps serving the older one.
      fetchImpl: (async () =>
        Response.json({
          data: [
            { id: alias, alias_target: 'vendor/new' },
            { id: 'vendor/new', pricing: { prompt: '0.000001', completion: '0.000002' } },
            { id: 'vendor/gw', pricing: { prompt: '0.000001', completion: '0.000002' } },
          ],
        })) as typeof fetch,
    };
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'run-gw', accuracy: 0.95 });
    const context: CustomRouterBenchmarkContext = {
      ownerType: 'user',
      ownerId: 'user-1',
      baseRouter: 'efficient',
      entries: [
        {
          kind: 'gateway',
          model: alias,
          servingPin: { model: 'vendor/gw', pinnedAt: '2026-11-20T00:00:00.000Z' },
        },
      ],
      clientEvalEntryKeys: [],
    };
    const status = await lookupCustomRouterStatuses(db, CONFIG, context, pinnedSource);
    expect(status.entries[0]?.variants[0]).toMatchObject({
      status: 'ready',
      servingModel: 'vendor/gw',
      availability: 'alias_rebenchmark_needed',
    });
    // The move changes no serving decision: the shared result of the old concrete target keeps
    // ranking under the alias and dispatching it, and the new target is never run or billed here.
    const { table, servingPins } = await assembleCustomRouterTable(
      db,
      CONFIG,
      context,
      pinnedSource
    );
    expect(candidates(table)).toEqual([expect.objectContaining({ model: alias, accuracy: 0.95 })]);
    expect(servingPins).toEqual({ [`gateway:${alias}`]: 'vendor/gw' });
    const executed = Object.values(table?.routes ?? {}).flatMap(route =>
      route.map(candidate => candidate.model)
    );
    expect(executed).not.toContain('vendor/new');
  });

  it('changes the table version with each upload to the served profile', async () => {
    clientProfile({ id: 'current', accuracy: 0.9, updatedAt: '2026-10-10' });
    const before = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    sqlite.exec(`UPDATE client_profiles SET results = results + 1`);
    const after = await assembleCustomRouterTable(db, CONFIG, clientOnly, source);
    expect(after.table?.version).not.toBe(before.table?.version);
  });

  it('reports ready, stale and missing per variant without admitting a run', async () => {
    clientProfile({ id: 'old', engine: OLD_ENGINE, accuracy: 0.8, updatedAt: '2026-10-01' });
    platformProfile({ engine: OLD_ENGINE, status: 'ready', runId: 'run-old', accuracy: 0.95 });
    const statuses = await lookupCustomRouterStatuses(
      db,
      CONFIG,
      {
        ...withGateway,
        entries: [{ ...localModel, variants: ['low', 'high'] }, withGateway.entries[1]!],
      },
      source
    );
    expect(statuses.entries).toEqual([
      {
        key: LOCAL,
        variants: [
          {
            variant: 'low',
            status: 'stale',
            failureReason: null,
            linked: false,
            availability: 'stale',
          },
          {
            variant: 'high',
            status: 'missing',
            failureReason: null,
            linked: false,
            availability: 'unbenchmarked',
          },
        ],
      },
      {
        key: 'gateway:vendor/gw',
        variants: [
          {
            variant: null,
            status: 'stale',
            failureReason: null,
            linked: false,
            availability: 'stale',
          },
        ],
      },
    ]);
    // A status read never admits a measurement: only an explicit paid confirmation does.
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM benchmark_profiles WHERE engine_identity = ? AND status = 'pending'"
        )
        .get(ENGINE)
    ).toEqual({ n: 0 });
  });

  it('reuses same-name platform variants while unmatched variants retain client measurements', async () => {
    clientProfile({ id: 'local-low', accuracy: 0.75, updatedAt: '2026-10-10' });
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'platform-ready', accuracy: 0.95 });
    const context = {
      ...clientOnly,
      entries: [{ ...localModel, variants: ['low'], measuredAs: 'vendor/gw' }],
    };
    const unmatched = await assembleCustomRouterTable(db, CONFIG, context, source);
    expect(candidates(unmatched.table)).toEqual([
      expect.objectContaining({ model: LOCAL, variant: 'low', accuracy: 0.75 }),
    ]);
    const linkedContext = {
      ...context,
      entries: [{ ...localModel, variants: [], measuredAs: 'vendor/gw' }],
    };
    const linked = await assembleCustomRouterTable(db, CONFIG, linkedContext, source);
    expect(linked.table?.routes[ROUTE]).toEqual([
      expect.objectContaining({ model: LOCAL, variant: null, accuracy: 0.95, avgCostUsd: 0 }),
    ]);
    expect(
      (await lookupCustomRouterStatuses(db, CONFIG, linkedContext, source)).entries[0]?.variants
    ).toEqual([
      {
        variant: null,
        linked: true,
        status: 'ready',
        failureReason: null,
        availability: 'ready',
      },
    ]);
  });

  it('reprices linked summaries exactly from token means and older summaries by price ratio', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'platform-ready', accuracy: 0.95 });
    const context = {
      ...clientOnly,
      entries: [
        {
          ...localModel,
          variants: [],
          measuredAs: 'vendor/gw',
          pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 4, cacheReadPerMTokUsd: 1 },
        },
      ],
    };
    const ratio = await assembleCustomRouterTable(db, CONFIG, context, source);
    expect(ratio.table?.routes[ROUTE]?.[0]?.avgCostUsd).toBeCloseTo(0.002);
    sqlite.exec(`UPDATE model_summaries SET avg_input_tokens = 100, avg_cached_input_tokens = 50,
      avg_output_tokens = 20, avg_reasoning_tokens = 10`);
    const exact = await assembleCustomRouterTable(db, CONFIG, context, source);
    expect(exact.table?.routes[ROUTE]?.[0]).toMatchObject({
      model: LOCAL,
      pricing: {
        promptUsdPerToken: 0.000002,
        completionUsdPerToken: 0.000004,
        cacheReadUsdPerToken: 0.000001,
      },
    });
    expect(exact.table?.routes[ROUTE]?.[0]?.avgCostUsd).toBeCloseTo(0.00037);
  });

  it('serves linked history as stale after the platform model leaves the catalog without admission', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'platform-ready', accuracy: 0.95 });
    const context = {
      ...clientOnly,
      entries: [{ ...localModel, variants: [], measuredAs: 'vendor/gw' }],
    };
    const removed = { ...source, fetchImpl: async () => Response.json({ data: [] }) };
    const { table } = await assembleCustomRouterTable(db, CONFIG, context, removed);
    expect(table?.routes[ROUTE]?.[0]).toMatchObject({ model: LOCAL, stale: true, avgCostUsd: 0 });
    const status = await lookupCustomRouterStatuses(db, CONFIG, context, removed);
    expect(status.entries[0]?.variants).toEqual([
      { variant: null, linked: true, status: 'stale', failureReason: null, availability: 'stale' },
    ]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 0,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_profiles').get()).toEqual({ n: 1 });
  });

  it('uses the direct gateway entry price and candidate name for linked measurements', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'platform-ready', accuracy: 0.95 });
    const context: CustomRouterBenchmarkContext = {
      ...clientOnly,
      entries: [{ kind: 'gateway', model: 'owner/model', measuredAs: 'vendor/gw' }],
      clientEvalEntryKeys: ['gateway:owner/model'],
    };
    const { table } = await assembleCustomRouterTable(db, CONFIG, context, {
      ...source,
      fetchImpl: async () =>
        Response.json({
          data: [
            { id: 'vendor/gw', pricing: { prompt: 0.000001, completion: 0.000002 } },
            { id: 'owner/model', pricing: { prompt: 0.000003, completion: 0.000006 } },
          ],
        }),
    });
    expect(table?.routes[ROUTE]?.[0]).toMatchObject({ model: 'owner/model' });
    expect(table?.routes[ROUTE]?.[0]?.avgCostUsd).toBeCloseTo(0.003);
  });

  it('omits a linked summary when neither tokens nor a platform price can reprice it', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'platform-ready', accuracy: 0.95 });
    const { table } = await assembleCustomRouterTable(
      db,
      CONFIG,
      {
        ...clientOnly,
        entries: [
          {
            ...localModel,
            variants: [],
            measuredAs: 'vendor/gw',
            pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 4 },
          },
        ],
      },
      { ...source, fetchImpl: async () => Response.json({ data: [{ id: 'vendor/gw' }] }) }
    );
    expect(table).toBeNull();
  });

  it('lists ready platform measurements across identities only for the requested base router', async () => {
    platformProfile({ engine: OLD_ENGINE, status: 'ready', runId: 'old-ready' });
    platformProfile({ engine: ENGINE, status: 'pending', runId: null });
    sqlite.exec(`INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
      status, run_id, requested_at, updated_at)
      VALUES ('frontier', 'other/model', 'high', 'older', 1, 'ready', 'frontier-ready', 'a', 'a')`);
    const env = {
      BENCH_DB: db,
      INTERNAL_API_SECRET_PROD: { get: async () => 'test-secret' },
    } as unknown as Env;
    const response = await app.request(
      `https://bench.test${PLATFORM_MEASUREMENTS_PATH}?router=efficient`,
      { headers: { authorization: 'Bearer test-secret' } },
      env
    );
    expect(response.status).toBe(200);
    expect(PlatformMeasurementsResponseSchema.parse(await response.json())).toEqual({
      baseRouter: 'efficient',
      models: [{ model: 'vendor/gw', variants: [null] }],
    });
    const denied = await app.request(`https://bench.test${PLATFORM_MEASUREMENTS_PATH}`, {}, env);
    expect(denied.status).toBe(401);
  });

  it('omits a ready virtual auto model that a linked entry cannot name', async () => {
    platformProfile({ engine: ENGINE, status: 'ready', runId: 'platform-ready' });
    sqlite.exec(`INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
      status, run_id, requested_at, updated_at)
      VALUES ('efficient', 'kilo-auto/free', '', 'older', 1, 'ready', 'virtual-ready', 'a', 'a')`);
    const env = {
      BENCH_DB: db,
      INTERNAL_API_SECRET_PROD: { get: async () => 'test-secret' },
    } as unknown as Env;
    const response = await app.request(
      `https://bench.test${PLATFORM_MEASUREMENTS_PATH}?router=efficient`,
      { headers: { authorization: 'Bearer test-secret' } },
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      baseRouter: 'efficient',
      models: [{ model: 'vendor/gw', variants: [null] }],
    });
  });
});
