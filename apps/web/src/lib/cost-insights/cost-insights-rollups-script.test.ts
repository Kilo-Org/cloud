import { parseCostInsightRollupScriptArgs } from '@/scripts/db/cost-insights-rollups';

describe('Cost Insights rollup operator arguments', () => {
  test('defaults to dry-run reconciliation', () => {
    expect(
      parseCostInsightRollupScriptArgs([
        '--start-hour',
        '2026-06-01T00:00:00.000Z',
        '--end-hour',
        '2026-06-01T02:00:00.000Z',
        '--max-hours',
        '2',
      ])
    ).toEqual({
      execute: false,
      startHour: '2026-06-01T00:00:00.000Z',
      endHourExclusive: '2026-06-01T02:00:00.000Z',
      maxHours: 2,
      sleepMs: 0,
    });
  });

  test('parses explicit execution and pacing', () => {
    expect(
      parseCostInsightRollupScriptArgs([
        '--execute',
        '--start-hour',
        '2026-06-01T00:00:00.000Z',
        '--end-hour',
        '2026-06-01T02:00:00.000Z',
        '--max-hours',
        '24',
        '--sleep-ms',
        '250',
      ])
    ).toMatchObject({ execute: true, maxHours: 24, sleepMs: 250 });
  });

  test('parses one-time live-capture coverage initialization only for execution', () => {
    expect(
      parseCostInsightRollupScriptArgs([
        '--execute',
        '--live-capture-start-hour',
        '2026-06-01T02:00:00.000Z',
        '--start-hour',
        '2026-06-01T00:00:00.000Z',
        '--end-hour',
        '2026-06-01T02:00:00.000Z',
        '--max-hours',
        '2',
      ])
    ).toMatchObject({ liveCaptureStartHour: '2026-06-01T02:00:00.000Z' });

    expect(() =>
      parseCostInsightRollupScriptArgs([
        '--live-capture-start-hour',
        '2026-06-01T02:00:00.000Z',
        '--start-hour',
        '2026-06-01T00:00:00.000Z',
        '--end-hour',
        '2026-06-01T02:00:00.000Z',
        '--max-hours',
        '2',
      ])
    ).toThrow('--live-capture-start-hour requires --execute');
  });

  test('rejects ranges beyond explicit maximum', () => {
    expect(() =>
      parseCostInsightRollupScriptArgs([
        '--start-hour',
        '2026-06-01T00:00:00.000Z',
        '--end-hour',
        '2026-06-01T03:00:00.000Z',
        '--max-hours',
        '2',
      ])
    ).toThrow('Requested range must contain 1-2 UTC hours');
  });

  test('rejects non-hour-aligned bounds', () => {
    expect(() =>
      parseCostInsightRollupScriptArgs([
        '--start-hour',
        '2026-06-01T00:30:00.000Z',
        '--end-hour',
        '2026-06-01T02:00:00.000Z',
        '--max-hours',
        '2',
      ])
    ).toThrow('exact UTC hour');
  });
});
