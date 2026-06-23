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
  test('accepts canonical yesterday cost queries with null timezone', () => {
    expect(
      GetKiloUsageCostInputSchema.safeParse({
        period: 'yesterday',
        timezone: null,
      }).success
    ).toBe(true);
  });

  test('accepts yesterday cost queries with an exact IANA timezone', () => {
    expect(
      GetKiloUsageCostInputSchema.safeParse({
        period: 'yesterday',
        timezone: 'Europe/Athens',
      }).success
    ).toBe(true);
  });

  test('rejects omitted timezone', () => {
    const result = GetKiloUsageCostInputSchema.safeParse({ period: 'yesterday' });

    expect(result.success).toBe(false);
  });

  test('rejects custom ranges on the convenience cost tool', () => {
    const result = GetKiloUsageCostInputSchema.safeParse({
      period: 'custom',
      timezone: null,
      startDate: '2026-06-22T00:00:00.000Z',
      endDate: '2026-06-23T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  test('rejects removed advanced cost properties', () => {
    const result = GetKiloUsageCostInputSchema.safeParse({
      period: 'last_7_days',
      timezone: null,
      groupBy: 'model',
      bucket: 'day',
      limit: 10,
    });

    expect(result.success).toBe(false);
  });
});
