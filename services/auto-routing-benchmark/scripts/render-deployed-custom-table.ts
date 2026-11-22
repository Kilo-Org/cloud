/**
 * Renders the golden custom routing table with the DEPLOYED builder/assembly
 * code, so `src/custom-routing-table-deployed-order.test.ts` can pin the
 * current build to what is live. Runs inside a scratch checkout of the deployed
 * tree (see that test's header for the exact recipe) and prints the fixture
 * document to stdout.
 *
 * The rows come from the same seeded SQLite fixture the test uses, inserted in
 * shuffled order, so this also covers the deployed readers' unqualified scans.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  CANONICAL_POOL,
  DEPLOYED_COMMIT,
  FIXTURE_CONFIG,
  FIXTURE_SOURCE,
  fixtureContext,
  seedCustomTableFixture,
  withoutGeneratedAt,
} from '../test/fixtures/custom-table-deployed-order';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { assembleCustomRouterTable } from '../src/custom-routers';

const sqlite = new DatabaseSync(':memory:');
applyBenchmarkMigrations(sqlite);
seedCustomTableFixture(sqlite);

const { table } = await assembleCustomRouterTable(
  sqliteD1(sqlite),
  FIXTURE_CONFIG,
  fixtureContext(CANONICAL_POOL),
  FIXTURE_SOURCE
);
if (!table) throw new Error('the deployed assembly produced no table for the fixture');

process.stdout.write(
  `${JSON.stringify(
    {
      _provenance: {
        commit: DEPLOYED_COMMIT,
        pool: CANONICAL_POOL,
        generator: 'services/auto-routing-benchmark/scripts/render-deployed-custom-table.ts',
      },
      table: withoutGeneratedAt(table),
    },
    null,
    2
  )}\n`
);
