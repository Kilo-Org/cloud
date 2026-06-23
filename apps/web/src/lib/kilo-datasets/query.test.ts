import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { defineTestUser } from '@/tests/helpers/user.helper';
import type * as queryModule from './query';

const mockTimedUsageQuery = jest.fn<() => Promise<unknown>>();

jest.mock('@/lib/usage-query', () => ({
  timedUsageQuery: mockTimedUsageQuery,
}));

const adminUser = defineTestUser({ id: 'admin-user', is_admin: true });
let queryKiloDatasetStats: typeof queryModule.queryKiloDatasetStats;

describe('queryKiloDatasetStats validation', () => {
  beforeAll(async () => {
    ({ queryKiloDatasetStats } = await import('./query'));
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
    ).rejects.toThrow('session datasets support count only');
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
});
