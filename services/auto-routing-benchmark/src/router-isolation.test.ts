import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  AutoRouterSchema,
  BenchmarkConfigSchema,
  BenchmarkRunSchema,
  StartBenchmarkRunRequestSchema,
  RequeueBenchmarkRegistryRequestSchema,
  type AutoRouter,
} from '@kilocode/auto-routing-contracts';
import {
  getConfigRows,
  getLatestRoutingTable,
  getRunningRun,
  listRuns,
  replaceConfig,
  replaceAutoDeciderModels,
  insertRun,
} from './db';

function capturingDatabase() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const result = { success: true, results: [], meta: { changes: 0 } };
  const db = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async raw() {
          queries.push({ sql, params });
          return [];
        },
        async all() {
          queries.push({ sql, params });
          return result;
        },
        async run() {
          queries.push({ sql, params });
          return result;
        },
      };
      return statement;
    },
    async batch(statements: Array<{ all(): Promise<typeof result> }>) {
      return Promise.all(statements.map(statement => statement.all()));
    },
  } as unknown as D1Database;
  return { db, queries };
}

const config = BenchmarkConfigSchema.parse({
  classifierModels: ['classifier'],
  deciderModels: [{ id: 'model' }],
  minAccuracy: 0.9,
  maxConcurrency: 30,
  userMaxConcurrency: 30,
  benchmarkUserId: null,
  switchCostFactor: 3,
  updatedAt: null,
  updatedBy: null,
});

describe('router contracts and database isolation', () => {
  it('defaults legacy config and mutation requests to efficient', () => {
    expect(config).toMatchObject({ router: 'efficient', accuracyNoiseBand: 0.05, frontierMinAccuracyDelta: 0 });
    expect(StartBenchmarkRunRequestSchema.parse({ kind: 'decider' }).router).toBe('efficient');
    expect(RequeueBenchmarkRegistryRequestSchema.parse({ scope: 'platform' }).router).toBe('efficient');
    expect(BenchmarkRunSchema.parse({
      id: 'run', kind: 'decider', status: 'completed', startedAt: 'now', completedAt: 'later',
      error: null, summaries: [],
    }).router).toBe('efficient');
    expect(AutoRouterSchema.safeParse('unknown').success).toBe(false);
  });

  it.each(['efficient', 'frontier'] as const)('scopes every config read to %s and does not fabricate it', async router => {
    const { db, queries } = capturingDatabase();
    const rows = await getConfigRows(db, router);
    expect(rows.config).toBeNull();
    expect(queries).toHaveLength(5);
    for (const query of queries) {
      expect(query.sql).toContain('"router" = ?');
      expect(query.params).toContain(router);
      expect(query.params).not.toContain(router === 'frontier' ? 'efficient' : 'frontier');
    }
  });

  it.each(['efficient', 'frontier'] as const)('isolates config and auto-model replacement for %s', async router => {
    const { db, queries } = capturingDatabase();
    await replaceConfig(db, {
      min_accuracy: config.minAccuracy,
      accuracy_noise_band: config.accuracyNoiseBand,
      frontier_min_accuracy_delta: config.frontierMinAccuracyDelta,
      switch_cost_factor: config.switchCostFactor,
      best_accuracy_switch_threshold: config.bestAccuracySwitchThreshold,
      max_concurrency: config.maxConcurrency,
      user_max_concurrency: config.userMaxConcurrency,
      benchmark_user_id: null,
      benchmark_org_id: null,
      classifier_repetitions: 1,
      decider_repetitions: 1,
      classifier_max_p95_latency_ms: 1000,
      auto_decider_min_cost_usd: 15,
      auto_decider_max_cost_usd: 25,
      updated_at: 'now',
      updated_by: null,
    }, ['classifier'], [{ model: 'model', variant: null, reasoning_effort: null }], ['excluded'], router);
    await replaceAutoDeciderModels(db, [{ model: 'auto', reasoning_effort: null, avg_attempt_cost_usd: 20, synced_at: 'now' }], router);
    const deletes = queries.filter(query => query.sql.startsWith('delete'));
    expect(deletes).toHaveLength(4);
    for (const query of deletes) {
      expect(query.sql).toContain('"router" = ?');
      expect(query.params).toEqual([router]);
    }
    for (const query of queries.filter(query => query.sql.startsWith('insert'))) {
      expect(query.sql).toContain('"router"');
      expect(query.params).toContain(router);
    }
  });

  it.each(['efficient', 'frontier'] as const)('isolates runs, active slots and published table reads for %s', async router => {
    const { db, queries } = capturingDatabase();
    await listRuns(db, 20, { router });
    await getRunningRun(db, 'decider', 'platform', router);
    await getLatestRoutingTable(db, router);
    expect(queries).toHaveLength(3);
    for (const query of queries) {
      expect(query.sql).toContain('"router" = ?');
      expect(query.params).toContain(router);
    }
  });

  it('keeps router selectors optional for existing service scripts', async () => {
    const { db, queries } = capturingDatabase();
    await getConfigRows(db);
    await listRuns(db, 20);
    await getLatestRoutingTable(db);
    expect(queries.every(query => query.params.includes('efficient' satisfies AutoRouter))).toBe(true);
  });
});

describe('atomic running-container admission', () => {
  it('counts live snapshots across routers, rejects overflow and leaves classifier admission unchanged', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`
      CREATE TABLE benchmark_runs (
        id TEXT PRIMARY KEY NOT NULL,
        router TEXT NOT NULL DEFAULT 'efficient',
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        min_accuracy REAL NOT NULL,
        accuracy_noise_band REAL NOT NULL DEFAULT 0.05,
        frontier_min_accuracy_delta REAL NOT NULL DEFAULT 0,
        switch_cost_factor REAL NOT NULL,
        best_accuracy_switch_threshold REAL NOT NULL DEFAULT 0.05,
        max_concurrency INTEGER NOT NULL,
        benchmark_user_id TEXT,
        benchmark_org_id TEXT,
        repetitions INTEGER NOT NULL DEFAULT 1,
        classifier_max_p95_latency_ms INTEGER,
        engine_identity TEXT NOT NULL DEFAULT '',
        purpose TEXT NOT NULL DEFAULT 'platform'
      );
      CREATE UNIQUE INDEX one_running_slot ON benchmark_runs(router, kind, purpose)
        WHERE status = 'running';
    `);
    const { db, queries } = capturingDatabase();
    const run = {
      id: 'efficient-running', router: 'efficient' as const, kind: 'decider' as const,
      startedAt: 'now', min_accuracy: 0.9, switch_cost_factor: 3,
      best_accuracy_switch_threshold: 0.05, max_concurrency: 180,
      benchmark_user_id: null, benchmark_org_id: null, repetitions: 1,
      classifier_max_p95_latency_ms: null, engine_identity: 'efficient:engine',
    };
    try {
      await insertRun(db, run, [], []);
      await insertRun(db, { ...run, id: 'frontier-running', router: 'frontier', max_concurrency: 20 }, [], []);
      await insertRun(db, { ...run, id: 'overflow', purpose: 'user', max_concurrency: 1 }, [], []);
      await insertRun(db, { ...run, id: 'classifier', kind: 'classifier', max_concurrency: 200 }, [], []);
      for (const query of queries.slice(0, 2)) sqlite.prepare(query.sql).run(...query.params as never[]);
      const overflow = queries[2];
      expect(() => sqlite.prepare(overflow.sql).run(...overflow.params as never[]))
        .toThrow('NOT NULL constraint failed: benchmark_runs.max_concurrency');
      const classifier = queries[3];
      sqlite.prepare(classifier.sql).run(...classifier.params as never[]);
      expect(sqlite.prepare('SELECT id FROM benchmark_runs ORDER BY id').all())
        .toEqual([{ id: 'classifier' }, { id: 'efficient-running' }, { id: 'frontier-running' }]);
    } finally {
      sqlite.close();
    }
  });
});
