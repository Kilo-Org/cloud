jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {} }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/usage-partitions', () => ({
  provisionComputeUsageChargePartitions: jest.fn(),
  provisionEnkryptUsagePartitions: jest.fn(),
  provisionExaUsageLogPartitions: jest.fn(),
}));

import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  provisionComputeUsageChargePartitions,
  provisionEnkryptUsagePartitions,
  provisionExaUsageLogPartitions,
} from '@/lib/usage-partitions';
import { GET } from './route';

describe('GET /api/cron/usage-partition-maintenance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(provisionExaUsageLogPartitions).mockResolvedValue({
      created: ['exa_usage_log_2026_11'],
      errors: [],
    });
    jest.mocked(provisionComputeUsageChargePartitions).mockResolvedValue({
      created: ['compute_usage_charge_2026_11'],
      errors: [],
    });
    jest.mocked(provisionEnkryptUsagePartitions).mockResolvedValue({
      created: ['enkrypt_usage_2026_11'],
      errors: [],
    });
  });

  afterEach(() => jest.restoreAllMocks());

  test.each([undefined, 'Bearer wrong-secret'])('rejects unauthorized requests: %s', async auth => {
    const response = await GET(
      new Request('http://localhost/api/cron/usage-partition-maintenance', {
        headers: auth ? { authorization: auth } : {},
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(provisionExaUsageLogPartitions).not.toHaveBeenCalled();
    expect(provisionComputeUsageChargePartitions).not.toHaveBeenCalled();
    expect(provisionEnkryptUsagePartitions).not.toHaveBeenCalled();
  });

  test('provisions all usage ledgers and includes Enkrypt partitions in the response', async () => {
    const response = await GET(
      new Request('http://localhost/api/cron/usage-partition-maintenance', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(provisionExaUsageLogPartitions).toHaveBeenCalledWith(db);
    expect(provisionComputeUsageChargePartitions).toHaveBeenCalledWith(db);
    expect(provisionEnkryptUsagePartitions).toHaveBeenCalledWith(db);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      created: ['exa_usage_log_2026_11', 'compute_usage_charge_2026_11', 'enkrypt_usage_2026_11'],
      errors: [],
    });
    expect(captureException).not.toHaveBeenCalled();
  });

  test('reports errors from every ledger while retaining successfully provisioned partitions', async () => {
    const exaError = new Error('Exa partition failed');
    const chargeError = new Error('compute partition failed');
    const enkryptError = 'Enkrypt partition failed';
    jest.mocked(provisionExaUsageLogPartitions).mockResolvedValue({
      created: ['exa_usage_log_2026_11'],
      errors: [{ name: 'exa_usage_log_2026_12', error: exaError }],
    });
    jest.mocked(provisionComputeUsageChargePartitions).mockResolvedValue({
      created: ['compute_usage_charge_2026_11'],
      errors: [{ name: 'compute_usage_charge_2026_12', error: chargeError }],
    });
    jest.mocked(provisionEnkryptUsagePartitions).mockResolvedValue({
      created: ['enkrypt_usage_2026_11'],
      errors: [{ name: 'enkrypt_usage_2026_12', error: enkryptError }],
    });

    const response = await GET(
      new Request('http://localhost/api/cron/usage-partition-maintenance', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    await expect(response.json()).resolves.toEqual({
      success: false,
      created: ['exa_usage_log_2026_11', 'compute_usage_charge_2026_11', 'enkrypt_usage_2026_11'],
      errors: [
        'Failed to create partition exa_usage_log_2026_12: Exa partition failed',
        'Failed to create partition compute_usage_charge_2026_12: compute partition failed',
        'Failed to create partition enkrypt_usage_2026_12: Enkrypt partition failed',
      ],
    });
    expect(captureException).toHaveBeenCalledTimes(3);
    expect(captureException).toHaveBeenCalledWith(enkryptError, {
      tags: { source: 'usage-partition-maintenance', partition: 'enkrypt_usage_2026_12' },
    });
  });
});
