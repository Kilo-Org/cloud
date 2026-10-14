import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { claimUserRequestedStatement } from './profiles';

const SCHEMA_SQL = `
  CREATE TABLE benchmark_profiles (
    model TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT '',
    engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    failure_reason TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    platform_requested INTEGER NOT NULL DEFAULT 0,
    user_requested INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (model, variant, engine_identity, repetitions)
  );
`;

type SqlQuery = { sql: string; params: unknown[] };

function toSql(stmt: { toSQL: () => SqlQuery }): SqlQuery {
  return stmt.toSQL();
}

/** node:sqlite Statement.run overloads confuse TS with mixed string/number args. */
function execSql(db: DatabaseSync, sqlText: string, params: readonly unknown[] = []): void {
  db.prepare(sqlText).run(...(params as never[]));
}

function runQuery(db: DatabaseSync, q: SqlQuery): void {
  execSql(db, q.sql, q.params);
}

describe('claimUserRequestedStatement (real SQLite)', () => {
  let db: DatabaseSync;
  const orm = drizzle({} as D1Database);
  const current = { engineIdentity: 'v-test:engine', repetitions: 1 };
  const NOW = '2026-07-28T13:00:00.000Z';

  function seed(model: string, engineIdentity: string, userRequested: 0 | 1): void {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
         (model, variant, engine_identity, repetitions, status, requested_at, updated_at,
          platform_requested, user_requested)
       VALUES (?, '', ?, 1, 'ready', '2026-07-28T12:00:00.000Z', '2026-07-28T12:00:00.000Z', 1, ?)`,
      [model, engineIdentity, userRequested]
    );
  }

  function flagOf(model: string): number {
    const row = db
      .prepare(`SELECT user_requested FROM benchmark_profiles WHERE model = ?`)
      .get(model) as { user_requested: number };
    return row.user_requested;
  }

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
  });

  it('records the owner on a row the platform list created', () => {
    // Without this the row stays platform-only. Drop the platform model from
    // the decider list and the pair leaves the registry, even though an owner
    // pool still points at it.
    seed('a/wanted', current.engineIdentity, 0);
    seed('b/untouched', current.engineIdentity, 0);

    runQuery(
      db,
      toSql(claimUserRequestedStatement(orm, [{ model: 'a/wanted', variant: null }], current, NOW))
    );

    expect(flagOf('a/wanted')).toBe(1);
    expect(flagOf('b/untouched')).toBe(0);
  });

  it('does not reach a row measured under another engine identity', () => {
    seed('a/wanted', 'v-other:engine', 0);

    runQuery(
      db,
      toSql(claimUserRequestedStatement(orm, [{ model: 'a/wanted', variant: null }], current, NOW))
    );

    expect(flagOf('a/wanted')).toBe(0);
  });

  it('matches the exact variant, not the model alone', () => {
    execSql(
      db,
      `INSERT INTO benchmark_profiles
         (model, variant, engine_identity, repetitions, status, requested_at, updated_at,
          platform_requested, user_requested)
       VALUES ('a/model', 'high', ?, 1, 'ready', ?, ?, 1, 0)`,
      [current.engineIdentity, NOW, NOW]
    );

    runQuery(
      db,
      toSql(claimUserRequestedStatement(orm, [{ model: 'a/model', variant: null }], current, NOW))
    );

    const row = db
      .prepare(`SELECT user_requested FROM benchmark_profiles WHERE variant = 'high'`)
      .get() as { user_requested: number };
    expect(row.user_requested).toBe(0);
  });
});
