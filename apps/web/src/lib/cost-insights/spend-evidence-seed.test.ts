import {
  assertDisposableFullCoverageSafe,
  buildCostInsightsSeedClock,
  parseSpendEvidenceArgs,
} from '../../../../../dev/seed/cost-insights/spend-evidence';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

describe('Cost Insights spend-evidence seed', () => {
  test('preserves global coverage by default', () => {
    expect(parseSpendEvidenceArgs([])).toEqual({
      rollupMode: 'bootstrap',
      coverageMode: 'preserve',
    });
  });

  test('requires explicit disposable full-coverage mode', () => {
    expect(
      parseSpendEvidenceArgs(['--coverage-mode', 'disposable-full', '--rollup-mode', 'healthy'])
    ).toEqual({
      rollupMode: 'healthy',
      coverageMode: 'disposable-full',
    });
  });

  test('rejects ambiguous coverage arguments', () => {
    expect(() =>
      parseSpendEvidenceArgs(['--coverage-mode', 'preserve', '--coverage-mode', 'disposable-full'])
    ).toThrow('Duplicate flag: --coverage-mode');
    expect(() => parseSpendEvidenceArgs(['--coverage-mode', 'global'])).toThrow(
      'Unknown coverage mode: global'
    );
  });

  test('builds seed dates relative to the seed timestamp', () => {
    const seedClock = buildCostInsightsSeedClock(Date.parse('2026-07-02T16:38:42.123Z'));

    expect(seedClock).toEqual({
      seededAtMs: Date.parse('2026-07-02T16:38:42.123Z'),
      seededAtIso: '2026-07-02T16:38:42.123Z',
      currentHour: Date.parse('2026-07-02T16:00:00.000Z'),
      currentHourIso: '2026-07-02T16:00:00.000Z',
      nextHourIso: '2026-07-02T17:00:00.000Z',
      coverageStartIso: '2026-04-03T16:00:00.000Z',
      maintenanceStartIso: '2026-07-01T15:00:00.000Z',
      lateArrivalHourIso: '2026-07-02T12:00:00.000Z',
      staleRollupHourIso: '2026-07-01T15:00:00.000Z',
    });
  });

  test('refuses disposable coverage when unrelated evidence exists', async () => {
    const dialect = new PgDialect();
    const statements: string[] = [];
    const fakeDb = {
      execute: async (query: SQL) => {
        statements.push(dialect.sqlToQuery(query).sql);
        return {
          rows: [
            {
              unrelated_canonical_count: '1',
              unrelated_rollup_count: '2',
              unresolved_degraded_count: '3',
            },
          ],
        };
      },
    };

    await expect(
      assertDisposableFullCoverageSafe(
        fakeDb as never,
        '2026-03-28T20:00:00.000Z',
        '2026-06-26T21:00:00.000Z'
      )
    ).rejects.toThrow(
      'found 1 unrelated canonical rows, 2 unrelated rollup rows, and 3 unrelated unresolved degraded intervals'
    );
    expect(statements[0]).toContain('unrelated_canonical');
    expect(statements[0]).toContain('unrelated_rollups');
    expect(statements[0]).toContain('cost_insight_rollup_degraded_intervals');
  });

  test('allows disposable coverage only after unrelated evidence verification passes', async () => {
    const fakeDb = {
      execute: async () => ({
        rows: [
          {
            unrelated_canonical_count: '0',
            unrelated_rollup_count: '0',
            unresolved_degraded_count: '0',
          },
        ],
      }),
    };

    await expect(
      assertDisposableFullCoverageSafe(
        fakeDb as never,
        '2026-03-28T20:00:00.000Z',
        '2026-06-26T21:00:00.000Z'
      )
    ).resolves.toBeUndefined();
  });
});
