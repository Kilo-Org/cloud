import { describe, expect, test } from '@jest/globals';
import { GetKiloUsageCostInputSchema, QueryKiloDatasetInputSchema } from './contracts';

function parseMessages(input: unknown): string[] {
  const result = QueryKiloDatasetInputSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map(issue => issue.message);
}

describe('QueryKiloDatasetInputSchema', () => {
  test('accepts aggregate cost queries without a bucket', () => {
    expect(
      QueryKiloDatasetInputSchema.safeParse({
        dataset: 'microdollar_usage',
        mode: 'aggregate',
        range: {
          startDate: '2026-06-22T00:00:00.000Z',
          endDate: '2026-06-23T00:00:00.000Z',
        },
        metrics: [
          { operation: 'sum', field: 'costUsd' },
          { operation: 'sum', field: 'costMicrodollars' },
        ],
      }).success
    ).toBe(true);
  });

  test('rejects aggregate queries with a bucket', () => {
    expect(
      parseMessages({
        dataset: 'microdollar_usage',
        mode: 'aggregate',
        bucket: 'day',
        metrics: [{ operation: 'sum', field: 'costUsd' }],
      })
    ).toContain('aggregate mode does not accept bucket; remove bucket or use mode: "timeseries"');
  });

  test('requires bucket for timeseries queries', () => {
    expect(
      parseMessages({
        dataset: 'microdollar_usage',
        mode: 'timeseries',
        metrics: [{ operation: 'sum', field: 'costUsd' }],
      })
    ).toContain('timeseries mode requires bucket: "hour", "day", or "week"');
  });

  test('rejects count metrics with a field', () => {
    expect(
      parseMessages({
        dataset: 'microdollar_usage',
        mode: 'aggregate',
        metrics: [{ operation: 'count', field: 'model' }],
      })
    ).toContain('count must not specify a field; use { "operation": "count" }');
  });

  test('requires fields for non-count metrics', () => {
    expect(
      parseMessages({
        dataset: 'microdollar_usage',
        mode: 'aggregate',
        metrics: [{ operation: 'sum' }],
      })
    ).toContain('sum requires a field from describe_kilo_dataset');
  });

  test('accepts count metrics without a field', () => {
    expect(
      QueryKiloDatasetInputSchema.safeParse({
        dataset: 'microdollar_usage',
        mode: 'aggregate',
        groupBy: ['model'],
        metrics: [{ operation: 'count' }],
        orderBy: [{ field: 'count', direction: 'desc' }],
      }).success
    ).toBe(true);
  });
});

describe('GetKiloUsageCostInputSchema', () => {
  test('accepts yesterday cost queries with a timezone', () => {
    expect(
      GetKiloUsageCostInputSchema.safeParse({
        period: 'yesterday',
        timezone: 'Europe/Athens',
      }).success
    ).toBe(true);
  });

  test('accepts grouped and bucketed cost queries', () => {
    expect(
      GetKiloUsageCostInputSchema.safeParse({
        period: 'last_7_days',
        timezone: 'UTC',
        groupBy: 'model',
        bucket: 'day',
      }).success
    ).toBe(true);
  });

  test('requires explicit dates for custom ranges', () => {
    const result = GetKiloUsageCostInputSchema.safeParse({ period: 'custom' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toEqual(
        expect.arrayContaining([
          'startDate is required when period is custom',
          'endDate is required when period is custom',
        ])
      );
    }
  });

  test('rejects manual dates for calendar periods', () => {
    const result = GetKiloUsageCostInputSchema.safeParse({
      period: 'yesterday',
      startDate: '2026-06-22T00:00:00.000Z',
      endDate: '2026-06-23T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toEqual(
        expect.arrayContaining([
          'startDate is only allowed when period is custom',
          'endDate is only allowed when period is custom',
        ])
      );
    }
  });

  test('rejects invalid timezones', () => {
    const result = GetKiloUsageCostInputSchema.safeParse({
      period: 'today',
      timezone: 'not-a-zone',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(issue => issue.message)).toContain(
        'timezone must be a valid IANA timezone, such as UTC'
      );
    }
  });
});
