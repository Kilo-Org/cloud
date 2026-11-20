import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
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
  MAX_RUNNING_RUNS_PER_QUEUE,
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
  updatedAt: null,
  updatedBy: null,
});

describe('router contracts and database isolation', () => {
  it('defaults legacy config and mutation requests to efficient', () => {
    expect(config).toMatchObject({
      router: 'efficient',
      accuracyNoiseBand: 0.05,
    });
    expect(config).not.toHaveProperty('frontierMinAccuracyDelta');
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
          benchmark_user_id: null,
          benchmark_org_id: null,
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
      if (!configInsert) throw new Error('replaceConfig did not insert a benchmark_config row');
      const [columnsSource = '', , valuesSource = ''] =
        /insert into "benchmark_config" \(([^)]*)\) values \(([^)]*)\)/.exec(configInsert.sql) ??
        [];
      const columns = columnsSource.split(', ').map(column => column.replaceAll('"', ''));
      // The values clause mixes bound parameters with inline literals, so bind
      // each placeholder to its own column instead of matching values by type.
      let bound = 0;
      const row = Object.fromEntries(
        columns.map((column, index) => {
          const value = valuesSource.split(', ')[index];
          if (value === '?') return [column, configInsert.params[bound++]];
          return [column, value === 'null' ? null : Number(value)];
        })
      );
      // The legacy fixed policy columns carry the canonical policy value so the
      // still-deployed worker reads valid settings.
      expect(row).toMatchObject({
        min_accuracy: config.minAccuracy,
        accuracy_noise_band: config.accuracyNoiseBand,
        frontier_min_accuracy_delta: 0,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        low_confidence_threshold: null,
        classifier_repetitions: 1,
        decider_repetitions: 1,
        classifier_max_p95_latency_ms: null,
        max_concurrency: 80,
        user_max_concurrency: 40,
      });
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

describe('atomic run lifecycle admission (production migrations)', () => {
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
    applyBenchmarkMigrations(sqlite);
    const db = sqliteD1(sqlite);
    const initialize = (id: string): void => {
      sqlite.prepare('INSERT INTO scheduler_runs (run_id) VALUES (?)').run(id);
    };
    const rowsOf = (id: string): unknown => ({
      runs: sqlite.prepare('SELECT COUNT(*) AS n FROM benchmark_runs WHERE id = ?').get(id),
      models: sqlite.prepare('SELECT COUNT(*) AS n FROM run_models WHERE run_id = ?').get(id),
    });
    const lanes = (): unknown =>
      sqlite
        .prepare(`SELECT SUM(max_concurrency) AS lanes FROM benchmark_runs WHERE kind = 'decider'`)
        .get();
    return { sqlite, db, initialize, rowsOf, lanes };
  }

  const models = (runId: string) => [
    { run_id: runId, model: 'vendor/a', variant: '', enqueued: true, reasoning_effort: null },
  ];

  it('admits every queue independently without reserving run-lifetime containers', async () => {
    const { sqlite, db, lanes } = admissionHarness();
    try {
      for (const queue of [
        { id: 'efficient-platform', router: 'efficient', purpose: 'platform', lanes: 150 },
        { id: 'frontier-platform', router: 'frontier', purpose: 'platform', lanes: 100 },
        { id: 'user-overflow', router: 'efficient', purpose: 'user', lanes: 1 },
      ] as const) {
        expect(
          await insertRun(
            db,
            { ...run, ...queue, max_concurrency: queue.lanes },
            models(queue.id),
            []
          )
        ).toEqual({ admitted: true });
      }
      expect(lanes()).toEqual({ lanes: 251 });
    } finally {
      sqlite.close();
    }
  });

  // 33 entries is the profile-drain batch size that once failed in production:
  // unchunked, its run_models insert binds 165 variables and D1 rejects it.
  it('writes a 33-entry decider run and carried classifier summaries within the D1 bind limit', async () => {
    const { sqlite, db, rowsOf } = admissionHarness();
    try {
      const entries = Array.from({ length: 33 }, (_, index) => ({
        run_id: 'decider-33',
        model: `model/${index}`,
        variant: '',
        enqueued: true,
        reasoning_effort: null,
      }));
      expect(await insertRun(db, { ...run, id: 'decider-33' }, entries, [])).toEqual({
        admitted: true,
      });
      expect(rowsOf('decider-33')).toEqual({ runs: { n: 1 }, models: { n: 33 } });

      const summaries = Array.from({ length: 10 }, (_, index) => ({
        model: `classifier/${index}`,
        routeKey: '*' as const,
        accuracy: 0.9,
        avgCostUsd: 0.001,
        avgInputTokens: 100.5,
        avgCachedInputTokens: 40.25,
        avgOutputTokens: 20.5,
        avgReasoningTokens: 10.75,
        avgLatencyMs: 100,
        p50LatencyMs: 90,
        p95LatencyMs: 120,
        cases: 216,
        errors: 0,
        timeouts: 0,
        routeAccuracy: null,
      }));
      await insertRun(db, { ...run, id: 'classifier-10', kind: 'classifier' }, [], summaries);
      expect(
        sqlite
          .prepare(
            `SELECT COUNT(*) AS n, MIN(avg_input_tokens) AS input, MIN(avg_reasoning_tokens) AS reasoning,
              MIN(carried) AS carried FROM model_summaries WHERE run_id = 'classifier-10'`
          )
          .get()
      ).toEqual({ n: 10, input: 100.5, reasoning: 10.75, carried: 1 });
    } finally {
      sqlite.close();
    }
  });

  it('admits initialized decider runs up to the queue cap and refuses the next without rows', async () => {
    const { sqlite, db, initialize, rowsOf } = admissionHarness();
    try {
      for (let index = 0; index < MAX_RUNNING_RUNS_PER_QUEUE; index++) {
        const id = `user-${index}`;
        expect(
          await insertRun(db, { ...run, id, purpose: 'user', max_concurrency: 0 }, models(id), [])
        ).toEqual({ admitted: true });
        initialize(id);
      }
      const refused = await insertRun(
        db,
        { ...run, id: 'user-over-cap', purpose: 'user', max_concurrency: 0 },
        models('user-over-cap'),
        []
      );

      expect(refused).toEqual({
        admitted: false,
        occupancy: { activeRuns: MAX_RUNNING_RUNS_PER_QUEUE, startingRunId: null },
      });
      expect(rowsOf('user-over-cap')).toEqual({ runs: { n: 0 }, models: { n: 0 } });
      expect(
        await insertRun(db, { ...run, id: 'platform', max_concurrency: 0 }, models('platform'), [])
      ).toEqual({ admitted: true });
    } finally {
      sqlite.close();
    }
  });

  it('refuses a second decider run while one of its queue is still starting', async () => {
    const { sqlite, db, initialize, rowsOf } = admissionHarness();
    try {
      await insertRun(
        db,
        { ...run, id: 'user-starting', purpose: 'user' },
        models('user-starting'),
        []
      );
      const refused = await insertRun(
        db,
        { ...run, id: 'user-second', purpose: 'user' },
        models('user-second'),
        []
      );

      expect(refused).toEqual({
        admitted: false,
        occupancy: { activeRuns: 1, startingRunId: 'user-starting' },
      });
      expect(rowsOf('user-second')).toEqual({ runs: { n: 0 }, models: { n: 0 } });
      initialize('user-starting');
      expect(
        await insertRun(
          db,
          { ...run, id: 'user-second', purpose: 'user' },
          models('user-second'),
          []
        )
      ).toEqual({ admitted: true });
      expect(rowsOf('user-second')).toEqual({ runs: { n: 1 }, models: { n: 1 } });
    } finally {
      sqlite.close();
    }
  });

  it('atomically keeps one active classifier run per router', async () => {
    const { sqlite, db } = admissionHarness();
    try {
      const classifier = { ...run, kind: 'classifier' as const, max_concurrency: 0 };
      await insertRun(db, { ...classifier, id: 'classifier-active' }, [], []);
      await expect(
        insertRun(db, { ...classifier, id: 'classifier-duplicate' }, [], [])
      ).rejects.toThrow('UNIQUE constraint failed');
      expect(
        await insertRun(db, { ...run, id: 'decider-alongside', max_concurrency: 0 }, [], [])
      ).toEqual({ admitted: true });
      sqlite
        .prepare("UPDATE benchmark_runs SET status = 'completed' WHERE id = ?")
        .run('classifier-active');
      expect(await insertRun(db, { ...classifier, id: 'classifier-duplicate' }, [], [])).toEqual({
        admitted: true,
      });
    } finally {
      sqlite.close();
    }
  });

  it('admits classifier runs without a container budget', async () => {
    const { sqlite, db, lanes } = admissionHarness();
    try {
      await insertRun(db, { ...run, id: 'decider' }, [], []);
      await insertRun(
        db,
        { ...run, id: 'classifier', kind: 'classifier', max_concurrency: 200 },
        [],
        []
      );

      expect(sqlite.prepare('SELECT id FROM benchmark_runs ORDER BY id').all()).toEqual([
        { id: 'classifier' },
        { id: 'decider' },
      ]);
      // The classifier row records its OpenRouter fan-out, never container lanes.
      expect(lanes()).toEqual({ lanes: 150 });
    } finally {
      sqlite.close();
    }
  });
});
