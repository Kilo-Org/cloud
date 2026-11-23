import { DatabaseSync } from 'node:sqlite';
import { applyBenchmarkMigrations, sqliteD1 } from './sqlite-d1';

/**
 * A paid-benchmark test database built from the **real** migrations, so every fixture is
 * checked against the schema the Worker actually runs (columns, defaults, unique partial
 * indexes and foreign keys included). Tests seed only the rows they need and assert against
 * the same tables the controller reads.
 */
export function openPaidDatabase(): { db: D1Database; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  return { db: sqliteD1(sqlite), sqlite };
}

/**
 * Insert the router config the planner reads. Column set mirrors the current migration, so a
 * schema change fails here loudly instead of silently passing against a hand-written table.
 */
export function seedBenchmarkConfig(
  sqlite: DatabaseSync,
  router: 'efficient' | 'frontier' = 'efficient'
): void {
  const at = '2026-01-01T00:00:00.000Z';
  sqlite
    .prepare(
      `INSERT INTO benchmark_config
        (router, min_accuracy, switch_cost_factor, max_concurrency, benchmark_user_id,
          benchmark_org_id, updated_at)
      VALUES (?, 0.7, 1, 80, 'bench-user', 'bench-org', ?)`
    )
    .run(router, at);
  sqlite
    .prepare('INSERT INTO config_classifier_models (router, model) VALUES (?, ?)')
    .run(router, 'vendor/classifier');
  sqlite
    .prepare('INSERT INTO config_decider_models (router, model) VALUES (?, ?)')
    .run(router, 'vendor/alpha');
}
