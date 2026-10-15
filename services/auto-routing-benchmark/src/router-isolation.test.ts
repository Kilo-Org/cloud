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
  benchmarkUserId: null,
  switchCostFactor: 3,
  updatedAt: null,
  updatedBy: null,
});

describe('router contracts and database isolation', () => {
  it('defaults legacy config and mutation requests to efficient', () => {
    expect(config).toMatchObject({
      router: 'efficient',
      accuracyNoiseBand: 0.05,
      frontierMinAccuracyDelta: 0,
    });
    expect(StartBenchmarkRunRequestSchema.parse({ kind: 'decider' }).router).toBe('efficient');
    expect(RequeueBenchmarkRegistryRequestSchema.parse({ scope: 'platform' }).router).toBe(
      'efficient'
    );
    expect(
      BenchmarkRunSchema.parse({
        id: 'run',
        kind: 'decider',
        status: 'completed',
        startedAt: 'now',
        completedAt: 'later',
        error: null,
        summaries: [],
      }).router
    ).toBe('efficient');
    expect(AutoRouterSchema.safeParse('unknown').success).toBe(false);
  });

  it.each(['efficient', 'frontier'] as const)(
    'scopes every config read to %s and does not fabricate it',
    async router => {
      const { db, queries } = capturingDatabase();
      const rows = await getConfigRows(db, router);
      expect(rows.config).toBeNull();
      expect(queries).toHaveLength(3);
      for (const query of queries) {
        expect(query.sql).toContain('"router" = ?');
        expect(query.params).toContain(router);
        expect(query.params).not.toContain(router === 'frontier' ? 'efficient' : 'frontier');
      }
    }
  );

  it.each(['efficient', 'frontier'] as const)(
    'isolates configured model replacement for %s',
    async router => {
      const { db, queries } = capturingDatabase();
      await replaceConfig(
        db,
        {
          min_accuracy: config.minAccuracy,
          accuracy_noise_band: config.accuracyNoiseBand,
          frontier_min_accuracy_delta: config.frontierMinAccuracyDelta,
          switch_cost_factor: config.switchCostFactor,
          best_accuracy_switch_threshold: config.bestAccuracySwitchThreshold,
          benchmark_user_id: null,
          benchmark_org_id: null,
          classifier_repetitions: 1,
          decider_repetitions: 1,
          classifier_max_p95_latency_ms: 1000,
          updated_at: 'now',
          updated_by: null,
        },
        ['classifier'],
        [{ model: 'model', variant: null, reasoning_effort: null }],
        router
      );
      const deletes = queries.filter(query => query.sql.startsWith('delete'));
      expect(deletes).toHaveLength(2);
      for (const query of deletes) {
        expect(query.sql).toContain('"router" = ?');
        expect(query.params).toEqual([router]);
      }
      for (const query of queries.filter(query => query.sql.startsWith('insert'))) {
        expect(query.sql).toContain('"router"');
        expect(query.params).toContain(router);
      }
      // Values the previously deployed worker accepts (80 + 40 + 80 = 200 across
      // both routers), never the shared budget, so a rollback stays valid.
      const configInsert = queries.find(
        query => query.sql.startsWith('insert') && query.sql.includes('"benchmark_config"')
      );
      expect(configInsert?.params).toEqual(expect.arrayContaining([80, 40]));
    }
  );

  it.each(['efficient', 'frontier'] as const)(
    'isolates runs, active slots and published table reads for %s',
    async router => {
      const { db, queries } = capturingDatabase();
      await listRuns(db, 20, { router });
      await getRunningRun(db, 'decider', 'platform', router);
      await getLatestRoutingTable(db, router);
      expect(queries).toHaveLength(3);
      for (const query of queries) {
        expect(query.sql).toContain('"router" = ?');
        expect(query.params).toContain(router);
      }
    }
  );

  it('keeps router selectors optional for existing service scripts', async () => {
    const { db, queries } = capturingDatabase();
    await getConfigRows(db);
    await listRuns(db, 20);
    await getLatestRoutingTable(db);
    expect(queries.every(query => query.params.includes('efficient' satisfies AutoRouter))).toBe(
      true
    );
  });
});

describe('atomic running-container admission', () => {
  const SCHEMA_SQL = `
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
  `;

  const run = {
    id: 'efficient-platform',
    router: 'efficient' as const,
    kind: 'decider' as const,
    startedAt: 'now',
    min_accuracy: 0.9,
    switch_cost_factor: 3,
    best_accuracy_switch_threshold: 0.05,
    max_concurrency: 150,
    benchmark_user_id: null,
    benchmark_org_id: null,
    repetitions: 1,
    classifier_max_p95_latency_ms: null,
    engine_identity: 'efficient:engine',
  };

  function admissionHarness() {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA_SQL);
    const { db, queries } = capturingDatabase();
    const apply = (index: number): void => {
      const query = queries[index];
      sqlite.prepare(query.sql).run(...(query.params as never[]));
    };
    const rejects = (index: number): void => {
      expect(() => apply(index)).toThrow(
        'NOT NULL constraint failed: benchmark_runs.max_concurrency'
      );
    };
    const lanes = (): unknown =>
      sqlite
        .prepare(`SELECT SUM(max_concurrency) AS lanes FROM benchmark_runs WHERE kind = 'decider'`)
        .get();
    return { sqlite, db, queries, apply, rejects, lanes };
  }

  it('caps the total across every router and purpose', async () => {
    const { sqlite, db, queries, apply, rejects, lanes } = admissionHarness();
    try {
      await insertRun(db, { ...run, id: 'efficient-platform' }, [], []);
      await insertRun(
        db,
        { ...run, id: 'frontier-platform', router: 'frontier', max_concurrency: 100 },
        [],
        []
      );
      await insertRun(
        db,
        { ...run, id: 'user-overflow', purpose: 'user', max_concurrency: 1 },
        [],
        []
      );

      apply(0);
      apply(1);
      rejects(2);
      expect(lanes()).toEqual({ lanes: 250 });
      expect(queries).toHaveLength(3);
    } finally {
      sqlite.close();
    }
  });

  it('caps owner runs at 150 and leaves 100 lanes for platform runs', async () => {
    const { sqlite, db, queries, apply, rejects, lanes } = admissionHarness();
    try {
      await insertRun(
        db,
        { ...run, id: 'user-full', purpose: 'user', max_concurrency: 150 },
        [],
        []
      );
      await insertRun(
        db,
        {
          ...run,
          id: 'user-overflow',
          router: 'frontier',
          purpose: 'user',
          max_concurrency: 1,
        },
        [],
        []
      );
      await insertRun(db, { ...run, id: 'platform-into-reserve', max_concurrency: 100 }, [], []);
      await insertRun(
        db,
        { ...run, id: 'platform-past-reserve', router: 'frontier', max_concurrency: 1 },
        [],
        []
      );

      apply(0);
      rejects(1);
      apply(2);
      rejects(3);
      expect(lanes()).toEqual({ lanes: 250 });
      expect(queries).toHaveLength(4);
    } finally {
      sqlite.close();
    }
  });

  it('admits classifier runs without a container budget', async () => {
    const { sqlite, db, queries, apply, lanes } = admissionHarness();
    try {
      await insertRun(db, { ...run, id: 'decider' }, [], []);
      await insertRun(
        db,
        { ...run, id: 'classifier', kind: 'classifier', max_concurrency: 200 },
        [],
        []
      );

      apply(0);
      apply(1);
      expect(sqlite.prepare('SELECT id FROM benchmark_runs ORDER BY id').all()).toEqual([
        { id: 'classifier' },
        { id: 'decider' },
      ]);
      // The classifier row records its OpenRouter fan-out, never container lanes.
      expect(lanes()).toEqual({ lanes: 150 });
      expect(queries).toHaveLength(2);
    } finally {
      sqlite.close();
    }
  });
});
