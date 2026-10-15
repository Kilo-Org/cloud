import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { CLASSIFIER_CASES } from './datasets/classifier-cases';
import { DECIDER_CASES } from './datasets/decider-cases';
import { computeEngineIdentity } from './run';
import { loadRunProgress } from './run-progress';

const classifierIdentity = computeEngineIdentity('classifier', 'efficient');
const deciderIdentity = computeEngineIdentity('decider', 'efficient');

function sqliteD1(sqlite: DatabaseSync): D1Database {
  return {
    prepare(sqlText: string) {
      const statement = sqlite.prepare(sqlText);
      return {
        bind(...params: unknown[]) {
          return {
            async raw() {
              return statement.all(...(params as never[])).map(row => Object.values(row));
            },
          };
        },
      };
    },
  } as D1Database;
}

function seed(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE benchmark_runs (
      id TEXT, kind TEXT, router TEXT, repetitions INTEGER,
      engine_identity TEXT, status TEXT
    );
    CREATE TABLE run_models (run_id TEXT, model TEXT, variant TEXT, enqueued INTEGER);
    CREATE TABLE case_results (
      run_id TEXT, model TEXT, variant TEXT, case_id TEXT, error TEXT, timed_out INTEGER
    );

    INSERT INTO benchmark_runs VALUES
      ('run-classifier', 'classifier', 'efficient', 2, '${classifierIdentity}', 'running'),
      ('run-just-started', 'decider', 'efficient', 1, '${deciderIdentity}', 'running'),
      ('run-drifted', 'decider', 'frontier', 1, 'frontier:v1:stale-dataset', 'running'),
      ('run-terminal', 'classifier', 'efficient', 1, '${classifierIdentity}', 'completed'),
      ('run-unlisted', 'decider', 'efficient', 1, '${deciderIdentity}', 'running');

    INSERT INTO run_models VALUES
      ('run-classifier', 'classifier/a', '', 1),
      ('run-classifier', 'classifier/b', '', 1),
      ('run-classifier', 'classifier/c', '', 0),
      ('run-just-started', 'model/a', '', 1),
      ('run-drifted', 'model/b', '', 1),
      ('run-terminal', 'classifier/a', '', 1),
      ('run-unlisted', 'model/c', '', 1);

    INSERT INTO case_results VALUES
      ('run-classifier', 'classifier/a', '', 'case-1', NULL, 0),
      ('run-classifier', 'classifier/a', '', 'case-2', 'grader failed', 0),
      ('run-classifier', 'classifier/b', '', 'case-3', NULL, 1),
      ('run-classifier', 'classifier/b', '', 'case-4', 'grader failed', 1),
      ('run-classifier', 'classifier/b', '', 'case-5', NULL, 0),
      ('run-drifted', 'model/b', '', 'case-1', NULL, 0),
      ('run-drifted', 'model/b', '', 'case-2', NULL, 0),
      ('run-terminal', 'classifier/a', '', 'case-1', NULL, 0),
      ('run-unlisted', 'model/c', '', 'case-1', NULL, 0);
  `);
}

describe('run progress counts', () => {
  it('tallies completed and failed cases and derives the expected total', async () => {
    const sqlite = new DatabaseSync(':memory:');
    seed(sqlite);
    try {
      const progress = await loadRunProgress(sqliteD1(sqlite), [
        'run-classifier',
        'run-just-started',
        'run-drifted',
        'run-terminal',
      ]);

      expect(progress.get('run-classifier')).toEqual({
        completedCases: 5,
        failedCases: 3,
        totalCases: 2 * CLASSIFIER_CASES.length * 2,
      });
      expect(progress.get('run-just-started')).toEqual({
        completedCases: 0,
        failedCases: 0,
        totalCases: DECIDER_CASES.length,
      });
    } finally {
      sqlite.close();
    }
  });

  it('reports no total when the run measured a different dataset', async () => {
    const sqlite = new DatabaseSync(':memory:');
    seed(sqlite);
    try {
      const progress = await loadRunProgress(sqliteD1(sqlite), ['run-drifted']);
      expect(progress.get('run-drifted')).toEqual({
        completedCases: 2,
        failedCases: 0,
        totalCases: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('omits terminal and unlisted runs', async () => {
    const sqlite = new DatabaseSync(':memory:');
    seed(sqlite);
    try {
      const progress = await loadRunProgress(sqliteD1(sqlite), ['run-terminal', 'run-classifier']);
      expect([...progress.keys()]).toEqual(['run-classifier']);
    } finally {
      sqlite.close();
    }
  });

  it('queries nothing for an empty run list', async () => {
    const unqueried = {
      prepare() {
        throw new Error('no query expected');
      },
    } as unknown as D1Database;
    await expect(loadRunProgress(unqueried, [])).resolves.toEqual(new Map());
  });
});
