/**
 * Pins the custom routing table to the order the DEPLOYED build (commit
 * 0487d998b60cbea224bf7ed69d5f6b6353b93de4) published, and proves the builder no
 * longer lets a caller's row order decide tied candidates.
 *
 * The golden file `test/fixtures/custom-table-deployed-0487d998.json` is not
 * hand-written: it was rendered from the deployed code through the full
 * `assembleCustomRouterTable` path (catalog fetch, DB readers, builder) over the
 * SAME seeded SQLite fixture this test uses, whose rows are inserted in a fixed
 * shuffled order so no table is stored in primary-key order. Regenerate it on a
 * VM from a checkout of this repository:
 *
 *   git archive 0487d998 services/auto-routing-benchmark packages/auto-routing-contracts \
 *     | tar -x -C <scratch>            # deployed source tree
 *   # copy this repo's test/fixtures/custom-table-deployed-order.ts and
 *   # scripts/render-deployed-custom-table.ts into <scratch> at the same paths,
 *   # hardlink-copy node_modules from a warm checkout, then:
 *   <scratch>/node_modules/.bin/tsx <scratch>/services/auto-routing-benchmark/scripts/render-deployed-custom-table.ts \
 *     > services/auto-routing-benchmark/test/fixtures/custom-table-deployed-0487d998.json
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  CANONICAL_POOL,
  DEPLOYED_COMMIT,
  FIXTURE_COMPLEXITY_LABELS,
  FIXTURE_CONFIG,
  FIXTURE_SOURCE,
  POOL_PERMUTATIONS,
  fixtureContext,
  fixturePerCaseResults,
  fixtureReadyEntries,
  fixtureSummaries,
  seedCustomTableFixture,
  withoutGeneratedAt,
} from '../test/fixtures/custom-table-deployed-order';
import { assembleCustomRouterTable } from './custom-routers';
import { buildCustomRoutingTable } from './routing-table-builder';

// `workers-types` shadows the Node URL type, so take the path as a string.
const GOLDEN_PATH = decodeURIComponent(
  new URL('../test/fixtures/custom-table-deployed-0487d998.json', import.meta.url).pathname
);

type Golden = {
  _provenance: { commit: string; pool: readonly string[] };
  table: unknown;
};

const golden: Golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));

function buildCanonical() {
  return buildCustomRoutingTable({
    generatedAt: '2026-11-22T00:00:00.000Z',
    minAccuracy: FIXTURE_CONFIG.minAccuracy,
    accuracyNoiseBand: FIXTURE_CONFIG.accuracyNoiseBand,
    switchCostFactor: 3,
    bestAccuracySwitchThreshold: 0.05,
    readyEntries: fixtureReadyEntries(),
    summaries: fixtureSummaries(),
    perCaseResults: fixturePerCaseResults(),
    complexityLabels: FIXTURE_COMPLEXITY_LABELS,
  });
}

/** Deterministic Fisher–Yates so a failure names the seed that broke it. */
function seededShuffle<T>(rows: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('buildCustomRoutingTable ignores caller row order', () => {
  const canonical = buildCanonical();
  const baseline = JSON.stringify(canonical);

  it('keeps the canonical table for the fixture', () => {
    expect(canonical).not.toBeNull();
    // Both variants tie on every ranking key; the pair key decides, not the input order.
    expect(canonical!.effortByComplexity?.['implementation/code_generation']).toMatchObject({
      'vendor/variants': { low: 'high', medium: 'high', high: 'high' },
    });
    expect(canonical!.routes['implementation/code_generation']?.map(c => c.model)).toEqual([
      'vendor/aaa',
      'vendor/variants',
      'vendor/variants',
      'vendor/zzz',
    ]);
  });

  it.each([1, 2, 3, 5, 8, 13, 21, 34])('emits identical bytes for seed %i', seed => {
    const shuffledSummaries = seededShuffle(fixtureSummaries(), seed);
    const shuffledCases = seededShuffle(fixturePerCaseResults(), seed + 1).map(pair => ({
      ...pair,
      results: seededShuffle(pair.results, seed + 2),
    }));
    const table = buildCustomRoutingTable({
      generatedAt: '2026-11-22T00:00:00.000Z',
      minAccuracy: FIXTURE_CONFIG.minAccuracy,
      accuracyNoiseBand: FIXTURE_CONFIG.accuracyNoiseBand,
      switchCostFactor: 3,
      bestAccuracySwitchThreshold: 0.05,
      readyEntries: seededShuffle(fixtureReadyEntries(), seed + 3),
      summaries: shuffledSummaries,
      perCaseResults: shuffledCases,
      complexityLabels: FIXTURE_COMPLEXITY_LABELS,
    });
    expect(table?.version).toBe(canonical!.version);
    expect(table?.routes).toEqual(canonical!.routes);
    expect(table?.effortByComplexity).toEqual(canonical!.effortByComplexity);
    expect(JSON.stringify(table)).toBe(baseline);
  });
});

describe('assembled custom table matches the deployed build', () => {
  it('renders the same bytes as the committed deployed golden from the same fixture', async () => {
    expect(golden._provenance.commit).toBe(DEPLOYED_COMMIT);
    const sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    seedCustomTableFixture(sqlite);
    const { table } = await assembleCustomRouterTable(
      sqliteD1(sqlite),
      FIXTURE_CONFIG,
      fixtureContext(CANONICAL_POOL),
      FIXTURE_SOURCE
    );
    expect(table).not.toBeNull();
    // Byte equality: same keys in the same order, not just a deep-equal document.
    expect(JSON.stringify(withoutGeneratedAt(table))).toBe(JSON.stringify(golden.table));
  });

  it('emits the golden bytes for every pool entry order', async () => {
    for (const pool of POOL_PERMUTATIONS) {
      const sqlite = new DatabaseSync(':memory:');
      applyBenchmarkMigrations(sqlite);
      seedCustomTableFixture(sqlite);
      const { table } = await assembleCustomRouterTable(
        sqliteD1(sqlite),
        FIXTURE_CONFIG,
        fixtureContext(pool),
        FIXTURE_SOURCE
      );
      expect(JSON.stringify(withoutGeneratedAt(table))).toBe(JSON.stringify(golden.table));
    }
  });
});
