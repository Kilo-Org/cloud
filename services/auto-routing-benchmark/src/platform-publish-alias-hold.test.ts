import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TAXONOMY_ROUTE_KEYS, type AutoRouter } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { getLatestRoutingTable, replaceConfig } from './db';
import { computeEngineIdentity, publishPlatformRoutingTable } from './run';

const ROUTE = TAXONOMY_ROUTE_KEYS[0];
const ALIAS = '~vendor/astra-latest';
const LIVE = 'vendor/astra-old';
const NEXT = 'vendor/astra-new';

let targets: Record<string, string> = {};
const catalogFetch = vi.fn<typeof fetch>(async () =>
  Response.json({
    data: [
      ...Object.entries(targets).map(([id, slug]) => ({ id, alias_target: slug })),
      ...['astra-old', 'astra-new'].map(name => ({
        id: `vendor/${name}`,
        pricing: { prompt: '0.000001', completion: '0.000002' },
      })),
    ],
  })
);

describe('publishPlatformRoutingTable — an alias move holds the live table, then switches', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let router: AutoRouter;
  let engine: string;

  beforeEach(() => {
    targets = { [ALIAS]: LIVE };
    catalogFetch.mockClear();
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    env = {
      BENCH_DB: sqliteD1(sqlite),
      AUTO_ROUTING_CONFIG: { delete: vi.fn(), put: vi.fn(), get: vi.fn() },
      KILO_WEB_API_BASE_URL: 'https://app.test',
    } as unknown as Env;
    router = 'frontier';
    engine = computeEngineIdentity('decider', router);
  });

  function seedSubscription(target: string, serving: string) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
         VALUES (?, 'platform', '', 'rev-1', ?, '2026-11-20T00:00:00.000Z')`
      )
      .run(
        router,
        JSON.stringify({
          entries: [
            {
              model: ALIAS,
              pairs: [{ model: target, variant: null }],
              servingPairs: [{ model: serving, variant: null }],
              resolutionError: null,
            },
          ],
          previousEntries: [],
        })
      );
  }

  function seedSummaries(model: string, runId: string, accuracy: number) {
    const summary = sqlite.prepare(
      `INSERT INTO model_summaries (run_id, model, variant, route_key, accuracy, avg_cost_usd,
        avg_latency_ms, p50_latency_ms, cases, errors, p95_latency_ms, timeouts)
       VALUES (?, ?, '', ?, ?, 0.001, 800, 800, 30, 0, 900, 0)`
    );
    for (const routeKey of TAXONOMY_ROUTE_KEYS) summary.run(runId, model, routeKey, accuracy);
  }

  function seedReady(model: string, runId: string, accuracy: number) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, completed_at, platform_requested, user_requested)
         VALUES (?, ?, '', ?, 1, 'ready', ?, '2026-11-20', '2026-11-20', '2026-11-20', 1, 0)`
      )
      .run(router, model, engine, runId);
    seedSummaries(model, runId, accuracy);
  }

  /** The new target's row as a run measuring it leaves it: admitted, not ready. */
  function seedPending(model: string) {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
          run_id, requested_at, updated_at, platform_requested, user_requested)
         VALUES (?, ?, '', ?, 1, 'pending', NULL, '2026-11-20', '2026-11-20', 1, 0)`
      )
      .run(router, model, engine);
  }

  async function configure() {
    await replaceConfig(
      env.BENCH_DB,
      {
        min_accuracy: 0.7,
        benchmark_user_id: null,
        benchmark_org_id: null,
        updated_at: '2026-11-20',
        updated_by: null,
      },
      ['classifier/a'],
      [{ model: ALIAS, variant: null, reasoning_effort: null }],
      router
    );
  }

  async function bootstrapLiveTable() {
    await configure();
    seedSubscription(LIVE, LIVE);
    seedReady(LIVE, 'run-astra-old', 0.9);
    expect(await publishPlatformRoutingTable(env, catalogFetch, router)).not.toBeNull();
    const live = await getLatestRoutingTable(env.BENCH_DB, router);
    expect((live?.table.routes[ROUTE] ?? []).map(candidate => candidate.model)).toEqual([LIVE]);
    return live?.table.version;
  }

  /** The daily run re-resolved the alias; the previous target still serves. */
  async function moveAlias() {
    targets = { [ALIAS]: NEXT };
    sqlite
      .prepare(
        "UPDATE benchmark_subscriptions SET snapshot = ?, revision = 'rev-2' WHERE router = ?"
      )
      .run(
        JSON.stringify({
          entries: [
            {
              model: ALIAS,
              pairs: [{ model: NEXT, variant: null }],
              servingPairs: [{ model: LIVE, variant: null }],
              resolutionError: null,
            },
          ],
          previousEntries: [],
        }),
        router
      );
    seedPending(NEXT);
  }

  it('logs the hold instead of returning null silently while the replacement is unready', async () => {
    const liveVersion = await bootstrapLiveTable();
    await moveAlias();

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const published = await publishPlatformRoutingTable(env, catalogFetch, router);
    const held = log.mock.calls
      .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .filter(entry => entry.event === 'routing_table_publish_skipped_serving_target_pending');
    log.mockRestore();

    expect(published).toBeNull();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      router,
      held: [
        {
          model: ALIAS,
          reason: 'replacement_pending',
          held: [{ model: LIVE, variant: null }],
        },
      ],
    });
    const live = await getLatestRoutingTable(env.BENCH_DB, router);
    expect(live?.table.version).toBe(liveVersion);
    expect((live?.table.routes[ROUTE] ?? []).map(candidate => candidate.model)).toEqual([LIVE]);
  });

  it('keeps the previous target serving until the new one is ready, then switches to it only', async () => {
    await bootstrapLiveTable();
    await moveAlias();

    expect(await publishPlatformRoutingTable(env, catalogFetch, router)).toBeNull();

    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'ready', run_id = ?, completed_at = '2026-11-20' WHERE router = ? AND model = ?"
      )
      .run('run-astra-new', router, NEXT);
    seedSummaries(NEXT, 'run-astra-new', 0.95);

    expect(await publishPlatformRoutingTable(env, catalogFetch, router)).not.toBeNull();
    const live = await getLatestRoutingTable(env.BENCH_DB, router);
    expect((live?.table.routes[ROUTE] ?? []).map(candidate => candidate.model)).toEqual([NEXT]);
    const snapshot = JSON.parse(
      String(
        sqlite
          .prepare(
            "SELECT snapshot FROM benchmark_subscriptions WHERE router = ? AND owner_type = 'platform'"
          )
          .get(router)?.snapshot
      )
    ) as { entries: { servingPairs: { model: string }[] }[] };
    expect(snapshot.entries[0]?.servingPairs).toEqual([{ model: NEXT, variant: null }]);
  });

  it('keeps the predecessor serving when the moved target fails to measure', async () => {
    const liveVersion = await bootstrapLiveTable();
    await moveAlias();
    sqlite
      .prepare("UPDATE benchmark_profiles SET status = 'failed' WHERE router = ? AND model = ?")
      .run(router, NEXT);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const published = await publishPlatformRoutingTable(env, catalogFetch, router);
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    // The alias still points at the failed target while its predecessor serves: the
    // table keeps the predecessor rather than dropping the alias.
    expect(published).toBeNull();
    expect(events.map(entry => entry.event)).toContain(
      'routing_table_publish_skipped_serving_target_pending'
    );
    const live = await getLatestRoutingTable(env.BENCH_DB, router);
    expect(live?.table.version).toBe(liveVersion);
    expect((live?.table.routes[ROUTE] ?? []).map(candidate => candidate.model)).toEqual([LIVE]);
  });

  it('drops a permanently unavailable target without a serving predecessor', async () => {
    // A second, healthy alias keeps the table publishable, so the drop path is reached
    // instead of the empty-table guard.
    const steadyAlias = '~vendor/steady-latest';
    const steady = 'vendor/steady';
    await replaceConfig(
      env.BENCH_DB,
      {
        min_accuracy: 0.7,
        benchmark_user_id: null,
        benchmark_org_id: null,
        updated_at: '2026-11-20',
        updated_by: null,
      },
      ['classifier/a'],
      [
        { model: ALIAS, variant: null, reasoning_effort: null },
        { model: steadyAlias, variant: null, reasoning_effort: null },
      ],
      router
    );
    const subscribe = () =>
      sqlite
        .prepare(
          `INSERT OR REPLACE INTO benchmark_subscriptions (router, owner_type, owner_id, revision, snapshot, updated_at)
           VALUES (?, 'platform', '', 'rev-1', ?, '2026-11-20T00:00:00.000Z')`
        )
        .run(
          router,
          JSON.stringify({
            entries: [
              {
                model: ALIAS,
                pairs: [{ model: NEXT, variant: null }],
                servingPairs: [{ model: NEXT, variant: null }],
                resolutionError: null,
              },
              {
                model: steadyAlias,
                pairs: [{ model: steady, variant: null }],
                servingPairs: [{ model: steady, variant: null }],
                resolutionError: null,
              },
            ],
            previousEntries: [],
          })
        );
    const insertProfile = sqlite.prepare(
      `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions, status,
        run_id, requested_at, updated_at, completed_at, platform_requested, user_requested,
        failure_class, failure_reason)
       VALUES (?, ?, '', ?, 1, ?, ?, '2026-11-20', '2026-11-20', '2026-11-20', 1, 0, ?, ?)`
    );
    subscribe();
    insertProfile.run(router, NEXT, engine, 'ready', 'run-next', null, null);
    insertProfile.run(router, steady, engine, 'ready', 'run-steady', null, null);
    seedSummaries(NEXT, 'run-next', 0.9);
    seedSummaries(steady, 'run-steady', 0.9);
    expect(await publishPlatformRoutingTable(env, catalogFetch, router)).not.toBeNull();

    // What an exhausted failure budget or a terminal class leaves behind (#12035).
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'unavailable', failure_class = 'catalog_absent' WHERE router = ? AND model = ?"
      )
      .run(router, NEXT);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const published = await publishPlatformRoutingTable(env, catalogFetch, router);
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    // `listCurrentPlatformProfileStatuses` reports the permanent row as `failed`, so the
    // publish treats it as settled: no predecessor to keep, and the rest still publishes.
    const reported = events.find(
      entry => entry.event === 'routing_table_publish_dropped_failed_pairs'
    );
    expect(reported?.dropped).toEqual([{ model: NEXT, variant: null, status: 'failed' }]);
    expect(
      events.some(entry => entry.event === 'routing_table_publish_skipped_serving_pair_unready')
    ).toBe(false);
    expect(published).not.toBeNull();
    const live = await getLatestRoutingTable(env.BENCH_DB, router);
    expect((live?.table.routes[ROUTE] ?? []).map(candidate => candidate.model)).toEqual([steady]);
  });

  it('keeps the predecessor of a permanently unavailable target', async () => {
    const liveVersion = await bootstrapLiveTable();
    await moveAlias();
    sqlite
      .prepare(
        "UPDATE benchmark_profiles SET status = 'unavailable', failure_class = 'model_not_found' WHERE router = ? AND model = ?"
      )
      .run(router, NEXT);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const published = await publishPlatformRoutingTable(env, catalogFetch, router);
    const events = log.mock.calls.map(([message]) => JSON.parse(String(message)));
    log.mockRestore();

    // The alias still names the unavailable target while its predecessor serves.
    expect(published).toBeNull();
    expect(events.map(entry => entry.event)).toContain(
      'routing_table_publish_skipped_serving_target_pending'
    );
    const live = await getLatestRoutingTable(env.BENCH_DB, router);
    expect(live?.table.version).toBe(liveVersion);
    expect((live?.table.routes[ROUTE] ?? []).map(candidate => candidate.model)).toEqual([LIVE]);
  });

  it('names the reason when the platform row has no configuration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await publishPlatformRoutingTable(env, catalogFetch, router)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'routing_table_publish_skipped_unconfigured', router })
    );
    warn.mockRestore();
  });

  it('names the reason when the serving set has no ready entry', async () => {
    await configure();
    seedSubscription(LIVE, LIVE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await publishPlatformRoutingTable(env, catalogFetch, router)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({ event: 'routing_table_publish_skipped_no_ready_entries' })
    );
    warn.mockRestore();
  });
});
