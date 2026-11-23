/**
 * Renders the golden custom routing tables with the DEPLOYED builder/assembly code, so
 * `src/custom-routing-table-deployed-order.test.ts` can pin the current build to what is live.
 * Runs inside a scratch checkout of the deployed tree (see that test's header for the exact
 * recipe) and prints the fixture document to stdout.
 *
 * Two pools are rendered, each from its own seeded database:
 *   - `CANONICAL_POOL` over `FIXTURE_PAIRS`: the routes tie order.
 *   - `EFFORT_POOL` over `EFFORT_PAIRS`: two models whose catalog variant declaration order
 *     disagrees with variant-name order, which is what decides `effortByComplexity`.
 *
 * The rows come from the same seeded SQLite fixture the test uses, inserted in shuffled order,
 * so this also covers the deployed readers' unqualified scans.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  CANONICAL_POOL,
  DEPLOYED_COMMIT,
  EFFORT_PAIRS,
  EFFORT_POOL,
  FIXTURE_CONFIG,
  FIXTURE_PAIRS,
  FIXTURE_SOURCE,
  fixtureContext,
  seedCustomTableFixture,
  withoutGeneratedAt,
} from '../test/fixtures/custom-table-deployed-order';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { assembleCustomRouterTable } from '../src/custom-routers';

async function render(
  pool: readonly string[],
  pairs: Parameters<typeof seedCustomTableFixture>[1]
) {
  const sqlite = new DatabaseSync(':memory:');
  applyBenchmarkMigrations(sqlite);
  seedCustomTableFixture(sqlite, pairs);
  const { table } = await assembleCustomRouterTable(
    sqliteD1(sqlite),
    FIXTURE_CONFIG,
    fixtureContext(pool),
    FIXTURE_SOURCE
  );
  sqlite.close();
  if (!table) throw new Error(`the deployed assembly produced no table for ${pool.join(', ')}`);
  return withoutGeneratedAt(table);
}

process.stdout.write(
  `${JSON.stringify(
    {
      _provenance: {
        commit: DEPLOYED_COMMIT,
        generator: 'services/auto-routing-benchmark/scripts/render-deployed-custom-table.ts',
      },
      // The routes/order golden.
      table: await render(CANONICAL_POOL, FIXTURE_PAIRS),
      // The effort golden: the same deployed build over a pool whose variant declaration order
      // is not alphabetical.
      effort: {
        pool: EFFORT_POOL,
        table: await render(EFFORT_POOL, EFFORT_PAIRS),
      },
    },
    null,
    2
  )}\n`
);
