import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { listPendingOutputRecoveries } from './db';

const ENGINE = 'efficient:test';

describe('pending output recovery sweep (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    sqlite
      .prepare(`
        INSERT INTO benchmark_runs (
          id, router, kind, purpose, status, started_at, completed_at, min_accuracy,
          switch_cost_factor, max_concurrency, repetitions, engine_identity
        ) VALUES ('terminal', 'efficient', 'decider', 'user', 'completed',
          '2026-10-20T00:00:00.000Z', '2026-10-20T01:00:00.000Z', 0.7, 3, 0, 1, ?)
      `)
      .run(ENGINE);
  });

  afterEach(() => sqlite.close());

  function insertPending(caseId: string, result: Record<string, unknown>) {
    sqlite
      .prepare(`
        INSERT INTO pending_decider_outputs (run_id, model, variant, case_id, rep, payload)
        VALUES ('terminal', 'vendor/model', '', ?, 0, ?)
      `)
      .run(
        caseId,
        JSON.stringify({
          result: {
            text: '',
            costUsd: null,
            latencyMs: 1,
            exitCode: 1,
            eventCount: 0,
            lastEventTypes: [],
            timedOut: false,
            ...result,
          },
          retried: false,
        })
      );
  }

  it('does not let retained unavailable-model outputs fill the bounded recovery page', async () => {
    for (const caseId of ['a', 'b', 'c']) {
      insertPending(`${caseId}-unavailable`, {
        stderrTail: 'Error: Model not found: kilo/vendor/model.',
        unavailableModelId: 'vendor/model',
      });
    }
    insertPending('d-catalog', {
      stderrTail:
        'Model not found: kilo/vendor/model. Failed to load the Kilo model catalog (network).',
      unavailableModelId: 'vendor/model',
    });
    insertPending('e-output', { text: 'answer', exitCode: 0, stderrTail: '' });

    const keys = await listPendingOutputRecoveries(sqliteD1(sqlite), 'efficient', ENGINE, 2);

    expect(keys.map(key => key.case_id)).toEqual(['d-catalog', 'e-output']);
  });
});
