import type { CostInsightQueryExecutor } from './canonical-sources';
import {
  getCostInsightRollupCoverage,
  getOwnerCurrentHourSpend,
  getOwnerHourlySpend,
  getOwnerTopSpendDriversByRange,
  getRolling24HourFragments,
  getRollingWindowFragments,
  groupContiguousHourlyIntervals,
} from './spend-repository';

const owner = { type: 'user', id: 'user-1' } as const;

function executorReturning(...rowsByCall: unknown[][]): CostInsightQueryExecutor {
  const execute = jest.fn();
  for (const rows of rowsByCall) {
    execute.mockResolvedValueOnce({ rows });
  }
  return { execute } as unknown as CostInsightQueryExecutor;
}

describe('Cost Insights spend repository', () => {
  test('splits exact rolling 24 hours into raw boundaries and rollup interior', () => {
    expect(getRolling24HourFragments('2026-06-02T12:30:00.000Z')).toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-06-01T12:30:00.000Z',
      oldestBoundaryEnd: '2026-06-01T13:00:00.000Z',
      interiorStart: '2026-06-01T13:00:00.000Z',
      interiorEnd: '2026-06-02T12:00:00.000Z',
      currentBoundaryStart: '2026-06-02T12:00:00.000Z',
    });
  });

  test('splits an exact rolling 30-day window into raw boundaries and rollup interior', () => {
    expect(getRollingWindowFragments('2026-06-02T12:30:00.000Z', 30 * 24)).toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-05-03T12:30:00.000Z',
      oldestBoundaryEnd: '2026-05-03T13:00:00.000Z',
      interiorStart: '2026-05-03T13:00:00.000Z',
      interiorEnd: '2026-06-02T12:00:00.000Z',
      currentBoundaryStart: '2026-06-02T12:00:00.000Z',
    });
  });

  test('splits an exact rolling 7-day window into raw boundaries and rollup interior', () => {
    expect(getRollingWindowFragments('2026-06-02T12:30:00.000Z', 7 * 24)).toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-05-26T12:30:00.000Z',
      oldestBoundaryEnd: '2026-05-26T13:00:00.000Z',
      interiorStart: '2026-05-26T13:00:00.000Z',
      interiorEnd: '2026-06-02T12:00:00.000Z',
      currentBoundaryStart: '2026-06-02T12:00:00.000Z',
    });
  });

  test('skips both raw fragments on exact UTC-hour boundaries', () => {
    const fragments = getRolling24HourFragments('2026-06-02T12:00:00.000Z');
    expect(fragments.windowStart).toBe(fragments.oldestBoundaryEnd);
    expect(fragments.currentBoundaryStart).toBe(fragments.asOf);
    expect(fragments.interiorStart).toBe('2026-06-01T12:00:00.000Z');
    expect(fragments.interiorEnd).toBe('2026-06-02T12:00:00.000Z');
  });

  test('groups adjacent hours with the same coverage state into intervals', () => {
    const points = [
      { hourStart: '2026-06-01T00:00:00.000Z', isCovered: false },
      { hourStart: '2026-06-01T01:00:00.000Z', isCovered: false },
      { hourStart: '2026-06-01T02:00:00.000Z', isCovered: true },
      { hourStart: '2026-06-01T03:00:00.000Z', isCovered: false },
    ];

    expect(groupContiguousHourlyIntervals(points, false)).toEqual([
      {
        startHour: '2026-06-01T00:00:00.000Z',
        endHourExclusive: '2026-06-01T02:00:00.000Z',
      },
      {
        startHour: '2026-06-01T03:00:00.000Z',
        endHourExclusive: '2026-06-01T04:00:00.000Z',
      },
    ]);
    expect(groupContiguousHourlyIntervals(points, true)).toEqual([
      {
        startHour: '2026-06-01T02:00:00.000Z',
        endHourExclusive: '2026-06-01T03:00:00.000Z',
      },
    ]);
  });

  test('returns covered sparse hours as zero and uncovered hours as null', async () => {
    const executor = executorReturning([
      {
        hour_start: '2026-06-01 02:00:00+02',
        variable_microdollars: '0',
        scheduled_microdollars: '0',
        variable_record_count: '0',
        scheduled_record_count: '0',
        is_covered: true,
      },
      {
        hour_start: '2026-06-01 01:00:00+00',
        variable_microdollars: null,
        scheduled_microdollars: null,
        variable_record_count: null,
        scheduled_record_count: null,
        is_covered: false,
      },
    ]);

    await expect(
      getOwnerHourlySpend(executor, {
        owner,
        startHour: '2026-06-01T00:00:00.000Z',
        endHourExclusive: '2026-06-01T02:00:00.000Z',
      })
    ).resolves.toEqual([
      {
        hourStart: '2026-06-01T00:00:00.000Z',
        variableMicrodollars: 0,
        scheduledMicrodollars: 0,
        totalMicrodollars: 0,
        variableRecordCount: 0,
        scheduledRecordCount: 0,
        isCovered: true,
      },
      {
        hourStart: '2026-06-01T01:00:00.000Z',
        variableMicrodollars: null,
        scheduledMicrodollars: null,
        totalMicrodollars: null,
        variableRecordCount: null,
        scheduledRecordCount: null,
        isCovered: false,
      },
    ]);
  });

  test('adds current-hour categories using safe integer conversion', async () => {
    const executor = executorReturning([
      {
        variable_microdollars: '13',
        scheduled_microdollars: '21',
        variable_record_count: '2',
        scheduled_record_count: '1',
      },
    ]);

    await expect(getOwnerCurrentHourSpend(executor, owner)).resolves.toEqual({
      variableMicrodollars: 13,
      scheduledMicrodollars: 21,
      totalMicrodollars: 34,
      variableRecordCount: 2,
      scheduledRecordCount: 1,
    });
  });

  test('returns independently ranked drivers for all ranges in one query', async () => {
    const executor = executorReturning([
      {
        range_key: '1h',
        spend_category: 'variable',
        source: 'ai_gateway',
        product_key: 'recent-winner',
        feature_key: 'other',
        model_or_plan_key: 'other',
        provider_key: 'other',
        actor_user_id: 'user-1',
        total_microdollars: '30',
        spend_record_count: '3',
      },
      {
        range_key: '24h',
        spend_category: 'scheduled',
        source: 'kiloclaw',
        product_key: 'day-winner',
        feature_key: 'other',
        model_or_plan_key: 'other',
        provider_key: 'other',
        actor_user_id: 'user-1',
        total_microdollars: '100',
        spend_record_count: '1',
      },
    ]);

    const driversByRange = await getOwnerTopSpendDriversByRange(executor, {
      owner,
      ranges: [
        { key: '1h', startHour: '2026-06-01T01:00:00.000Z' },
        { key: '24h', startHour: '2026-05-31T02:00:00.000Z' },
      ],
      endHourExclusive: '2026-06-01T02:00:00.000Z',
    });

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(driversByRange.get('1h')).toEqual([
      expect.objectContaining({ productKey: 'recent-winner', totalMicrodollars: 30 }),
    ]);
    expect(driversByRange.get('24h')).toEqual([
      expect.objectContaining({ productKey: 'day-winner', totalMicrodollars: 100 }),
    ]);
  });

  test('marks range incomplete when unresolved degraded interval overlaps it', async () => {
    const executor = executorReturning(
      [
        {
          rollup_version: '1',
          live_capture_start_hour: '2026-06-01 00:00:00+00',
          coverage_start_hour: '2026-05-01 00:00:00+00',
          last_reconciled_at: '2026-06-02 00:00:00+00',
          database_now: '2026-06-03 00:30:00+00',
        },
      ],
      [
        {
          id: 'degraded-1',
          start_hour: '2026-06-01 01:00:00+00',
          end_hour_exclusive: '2026-06-01 02:00:00+00',
          source: 'other',
          reason: 'capture_bypass',
          detected_at: '2026-06-01 02:00:00+00',
        },
      ]
    );

    const coverage = await getCostInsightRollupCoverage(executor, {
      startHour: '2026-06-01T00:00:00.000Z',
      endHourExclusive: '2026-06-01T03:00:00.000Z',
    });

    expect(coverage).toMatchObject({
      rollupVersion: 1,
      liveCaptureStartHour: '2026-06-01T00:00:00.000Z',
      coverageStartHour: '2026-05-01T00:00:00.000Z',
      lastReconciledAt: '2026-06-02T00:00:00.000Z',
      isFullyCovered: false,
    });
    expect(coverage.degradedIntervals).toEqual([
      expect.objectContaining({
        id: 'degraded-1',
        startHour: '2026-06-01T01:00:00.000Z',
        endHourExclusive: '2026-06-01T02:00:00.000Z',
      }),
    ]);
  });

  test('rejects more than 90 days of hourly buckets', async () => {
    const executor = executorReturning([]);
    await expect(
      getOwnerHourlySpend(executor, {
        owner,
        startHour: '2026-01-01T00:00:00.000Z',
        endHourExclusive: '2026-04-02T00:00:00.000Z',
      })
    ).rejects.toThrow('between 1 and 2160 UTC hours');
  });
});
