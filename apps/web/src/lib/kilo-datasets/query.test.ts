import { describe, expect, test } from '@jest/globals';
import { defineTestUser } from '@/tests/helpers/user.helper';
import { queryKiloDatasetStats } from './query';

const adminUser = defineTestUser({ id: 'admin-user', is_admin: true });

describe('queryKiloDatasetStats validation', () => {
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
});
