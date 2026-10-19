import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BENCHMARK_CONTAINER_BUDGET,
  BenchmarkSchedulerConfigResponseSchema,
  type BenchmarkSchedulerOverrides,
} from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { app } from './index';
import { dispatchScheduler } from './run';
import { getSchedulerOverrides, resolveSchedulerConfig, scheduleRunChunks } from './scheduler';

const NO_OVERRIDES: BenchmarkSchedulerOverrides = {
  slots: null,
  modelConcurrency: null,
  providerConcurrency: null,
  unknownProviderConcurrency: null,
};

describe('resolveSchedulerConfig', () => {
  it('prefers the admin override, then BENCHMARK_SCHEDULER_CONFIG, then the default', () => {
    const { config, settings } = resolveSchedulerConfig(
      '{"modelConcurrency":4,"providerConcurrency":20,"modelLimits":{"slow/model":1}}',
      { ...NO_OVERRIDES, modelConcurrency: 30 }
    );
    expect(settings).toEqual({
      slots: { effective: 250, source: 'default', override: null, fallback: 250 },
      modelConcurrency: { effective: 30, source: 'admin', override: 30, fallback: 4 },
      providerConcurrency: { effective: 20, source: 'env', override: null, fallback: 20 },
      unknownProviderConcurrency: { effective: 2, source: 'default', override: null, fallback: 2 },
    });
    expect(config).toMatchObject({
      slots: 250,
      modelConcurrency: 30,
      providerConcurrency: 20,
      unknownProviderConcurrency: 2,
      modelLimits: { 'slow/model': 1 },
    });
  });

  it('defaults the per-model cap to 12', () => {
    expect(resolveSchedulerConfig(undefined, NO_OVERRIDES).settings.modelConcurrency).toEqual({
      effective: 12,
      source: 'default',
      override: null,
      fallback: 12,
    });
  });
});

describe('scheduler settings (admin API, dispatch, real SQLite)', () => {
  let directory: string;
  let sqlite: DatabaseSync;
  let db: D1Database;
  const queueSend = vi.fn();
  let envConfig: string;

  const env = () =>
    ({
      INTERNAL_API_SECRET_PROD: { get: async () => 'bench-token' },
      BENCH_DB: db,
      BENCH_QUEUE: { send: queueSend },
      BENCHMARK_SCHEDULER_CONFIG: envConfig,
    }) as unknown as Env;

  const request = (init: RequestInit = {}) =>
    app.request('https://bench.example.com/admin/scheduler-config', init, env());

  const put = (body: unknown) =>
    request({
      method: 'PUT',
      headers: {
        authorization: 'Bearer bench-token',
        'content-type': 'application/json',
        'x-updated-by': 'admin@example.com',
      },
      body: JSON.stringify(body),
    });

  const get = async () => {
    const response = await request({ headers: { authorization: 'Bearer bench-token' } });
    expect(response.status).toBe(200);
    return BenchmarkSchedulerConfigResponseSchema.parse(await response.json());
  };

  const queuedModels = () =>
    sqlite
      .prepare("SELECT model FROM scheduler_chunks WHERE status = 'queued'")
      .all()
      .map(row => row.model);

  async function scheduleOneModel(chunks: number) {
    sqlite
      .prepare(`
      INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at,
        min_accuracy, switch_cost_factor, max_concurrency, repetitions, engine_identity
      ) VALUES ('run', 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 4, 1, 'settings-test')
    `)
      .run(new Date().toISOString());
    await scheduleRunChunks(db, {
      runId: 'run',
      entries: [{ model: 'deep/model', variant: '', providers: ['deepinfra'] }],
      repetitions: 1,
      caseIds: Array.from({ length: chunks }, (_, index) => `case-${index}`),
      chunkSize: 1,
    });
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'benchmark-scheduler-settings-'));
    sqlite = new DatabaseSync(join(directory, 'scheduler.sqlite'));
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
    envConfig = '{}';
    queueSend.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('stores an admin override that survives reads and clears back to the env value', async () => {
    envConfig = '{"modelConcurrency":4}';
    expect((await get()).settings.modelConcurrency).toEqual({
      effective: 4,
      source: 'env',
      override: null,
      fallback: 4,
    });

    const saved = await put({ modelConcurrency: 12, slots: 100 });
    expect(saved.status).toBe(200);
    const afterSave = await get();
    expect(afterSave.settings.modelConcurrency).toEqual({
      effective: 12,
      source: 'admin',
      override: 12,
      fallback: 4,
    });
    expect(afterSave.settings.slots).toMatchObject({ effective: 100, source: 'admin' });
    expect(afterSave.updatedBy).toBe('admin@example.com');
    expect(afterSave.updatedAt).not.toBeNull();

    expect((await put({})).status).toBe(200);
    const cleared = await get();
    expect(cleared.settings.modelConcurrency).toMatchObject({ effective: 4, source: 'env' });
    expect(cleared.settings.slots).toMatchObject({ effective: 250, source: 'default' });
  });

  it.each([
    ['below 1', { modelConcurrency: 0 }],
    ['non-integer', { providerConcurrency: 1.5 }],
    ['above the container budget', { slots: BENCHMARK_CONTAINER_BUDGET + 1 }],
    ['a numeric string', { unknownProviderConcurrency: '3' }],
    ['an unknown setting', { modelConcurency: 12 }],
  ])('rejects %s without changing the stored overrides', async (_label, body) => {
    expect((await put({ modelConcurrency: 8 })).status).toBe(200);
    const response = await put(body);
    expect(response.status).toBe(400);
    expect((await getSchedulerOverrides(db)).overrides).toEqual({
      ...NO_OVERRIDES,
      modelConcurrency: 8,
    });
  });

  it('claims up to 12 chunks of one model per dispatch under the default cap', async () => {
    await scheduleOneModel(20);
    await dispatchScheduler(env());
    expect(queuedModels()).toEqual(Array(12).fill('deep/model'));
    expect(queueSend).toHaveBeenCalledTimes(12);
  });

  it('applies a raised admin model cap on the next dispatch without an env change', async () => {
    envConfig = '{"modelConcurrency":4}';
    await scheduleOneModel(20);
    await dispatchScheduler(env());
    expect(queuedModels()).toHaveLength(4);

    expect((await put({ modelConcurrency: 12 })).status).toBe(200);
    await dispatchScheduler(env());
    expect(queuedModels()).toEqual(Array(12).fill('deep/model'));
  });
});
