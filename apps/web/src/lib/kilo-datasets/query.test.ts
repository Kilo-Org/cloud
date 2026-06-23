import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineTestUser } from '@/tests/helpers/user.helper';
import type * as queryModule from './query';

const mockTimedUsageQuery = jest.fn<() => Promise<unknown>>();

jest.mock('@/lib/usage-query', () => ({
  timedUsageQuery: mockTimedUsageQuery,
}));

const adminUser = defineTestUser({ id: 'admin-user', is_admin: true });
let getKiloUsageCost: typeof queryModule.getKiloUsageCost;
let queryKiloDatasetStats: typeof queryModule.queryKiloDatasetStats;

describe('queryKiloDatasetStats validation', () => {
  beforeAll(async () => {
    ({ getKiloUsageCost, queryKiloDatasetStats } = await import('./query'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects requested ranges over 60 days before executing a query', async () => {
    await expect(
      queryKiloDatasetStats({
        user: adminUser,
        now: new Date('2026-06-01T00:00:00.000Z'),
        input: {
          dataset: 'microdollar_usage',
          mode: 'aggregate',
          range: {
            startDate: '2026-01-01T00:00:00.000Z',
            endDate: '2026-06-01T00:00:00.000Z',
          },
          metrics: [{ operation: 'count' }],
        },
      })
    ).rejects.toThrow('range cannot exceed 60 days');
  });

  test('rejects sensitive or unknown metric fields', async () => {
    await expect(
      queryKiloDatasetStats({
        user: adminUser,
        now: new Date('2026-06-01T00:00:00.000Z'),
        input: {
          dataset: 'microdollar_usage',
          mode: 'aggregate',
          metrics: [{ operation: 'sum', field: 'abuse_classification' }],
        },
      })
    ).rejects.toThrow('metric field is not allowed');
  });

  test('lists allowed usage cost metric fields for unknown cost aliases', async () => {
    await expect(
      queryKiloDatasetStats({
        user: adminUser,
        now: new Date('2026-06-01T00:00:00.000Z'),
        input: {
          dataset: 'microdollar_usage',
          mode: 'aggregate',
          metrics: [{ operation: 'sum', field: 'microdollars' }],
        },
      })
    ).rejects.toThrow('allowed metric fields for microdollar_usage are costMicrodollars, costUsd');
  });

  test('explains count metric shape before executing a query', async () => {
    await expect(
      queryKiloDatasetStats({
        user: adminUser,
        now: new Date('2026-06-01T00:00:00.000Z'),
        input: {
          dataset: 'microdollar_usage',
          mode: 'aggregate',
          metrics: [{ operation: 'count', field: 'model' }],
        },
      })
    ).rejects.toThrow('count must not specify a field');
    expect(mockTimedUsageQuery).not.toHaveBeenCalled();
  });

  test('keeps session datasets count-only for the MVP', async () => {
    await expect(
      queryKiloDatasetStats({
        user: adminUser,
        now: new Date('2026-06-01T00:00:00.000Z'),
        input: {
          dataset: 'cli_sessions',
          mode: 'aggregate',
          metrics: [{ operation: 'sum', field: 'version' }],
        },
      })
    ).rejects.toThrow(
      'session datasets support count only in this MVP; use metrics: [{ "operation": "count" }]'
    );
  });

  test('serializes string-backed boolean values explicitly', async () => {
    mockTimedUsageQuery.mockResolvedValue({
      rows: [
        { hasError: 'f', count: '1' },
        { hasError: 'false', count: '2' },
        { hasError: 't', count: '3' },
        { hasError: 'true', count: '4' },
      ],
    });

    await expect(
      queryKiloDatasetStats({
        user: adminUser,
        now: new Date('2026-06-01T00:00:00.000Z'),
        input: {
          dataset: 'microdollar_usage',
          mode: 'aggregate',
          groupBy: ['hasError'],
          metrics: [{ operation: 'count' }],
        },
      })
    ).resolves.toMatchObject({
      rows: [
        { hasError: false, count: 1 },
        { hasError: false, count: 2 },
        { hasError: true, count: 3 },
        { hasError: true, count: 4 },
      ],
    });
  });

  test('gets yesterday usage cost with timezone-aware calendar boundaries', async () => {
    mockTimedUsageQuery.mockResolvedValue({
      rows: [{ sum_costUsd: '0.42', sum_costMicrodollars: '420000' }],
    });

    await expect(
      getKiloUsageCost({
        user: adminUser,
        now: new Date('2026-06-23T13:00:00.000Z'),
        input: { period: 'yesterday', timezone: 'Europe/Athens' },
      })
    ).resolves.toMatchObject({
      dataset: 'microdollar_usage',
      period: 'yesterday',
      timezone: 'Europe/Athens',
      range: {
        startDate: '2026-06-21T21:00:00.000Z',
        endDate: '2026-06-22T21:00:00.000Z',
        timeField: 'createdAt',
      },
      rows: [{ costUsd: '0.42', costMicrodollars: 420000 }],
      summary: {
        totalCostUsd: '0.42',
        totalCostMicrodollars: 420000,
        rowCount: 1,
      },
      query: {
        tool: 'query_kilo_dataset',
        input: {
          dataset: 'microdollar_usage',
          mode: 'aggregate',
          range: {
            startDate: '2026-06-21T21:00:00.000Z',
            endDate: '2026-06-22T21:00:00.000Z',
          },
          metrics: [
            { operation: 'sum', field: 'costUsd' },
            { operation: 'sum', field: 'costMicrodollars' },
          ],
        },
      },
    });
  });

  test('gets grouped usage cost with safe cost ordering', async () => {
    mockTimedUsageQuery.mockResolvedValue({
      rows: [
        { model: 'claude-sonnet-4', sum_costUsd: '1.5', sum_costMicrodollars: '1500000' },
        { model: 'gpt-5.5', sum_costUsd: '0.25', sum_costMicrodollars: '250000' },
      ],
    });

    await expect(
      getKiloUsageCost({
        user: adminUser,
        now: new Date('2026-06-23T13:00:00.000Z'),
        input: { period: 'last_7_days', timezone: 'UTC', groupBy: 'model' },
      })
    ).resolves.toMatchObject({
      groupBy: 'model',
      rows: [
        { model: 'claude-sonnet-4', costUsd: '1.5', costMicrodollars: 1500000 },
        { model: 'gpt-5.5', costUsd: '0.25', costMicrodollars: 250000 },
      ],
      summary: {
        totalCostUsd: '1.75',
        totalCostMicrodollars: 1750000,
        rowCount: 2,
      },
      query: {
        input: {
          mode: 'aggregate',
          groupBy: ['model'],
          orderBy: [{ field: 'sum_costUsd', direction: 'desc' }],
        },
      },
    });
  });

  test('gets bucketed usage cost with a timeseries query', async () => {
    mockTimedUsageQuery.mockResolvedValue({
      rows: [
        {
          bucketStart: '2026-06-22 00:00:00+00',
          sum_costUsd: '0.1',
          sum_costMicrodollars: '100000',
        },
      ],
    });

    await expect(
      getKiloUsageCost({
        user: adminUser,
        now: new Date('2026-06-23T13:00:00.000Z'),
        input: { period: 'last_7_days', timezone: 'UTC', bucket: 'day' },
      })
    ).resolves.toMatchObject({
      bucket: 'day',
      rows: [
        {
          bucketStart: '2026-06-22T00:00:00.000Z',
          costUsd: '0.1',
          costMicrodollars: 100000,
        },
      ],
      query: { input: { mode: 'timeseries', bucket: 'day' } },
    });
  });
});
