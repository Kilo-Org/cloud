import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/ai-gateway/usage-daily-rollup-repairs', () => ({
  processPendingDailyUsageRollupRepairs: jest.fn(),
}));
const mockSentryLog = jest.fn();
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => mockSentryLog) }));

import { processPendingDailyUsageRollupRepairs } from '@/lib/ai-gateway/usage-daily-rollup-repairs';
import { GET, maxDuration } from './route';

const mockProcessPendingDailyUsageRollupRepairs = jest.mocked(
  processPendingDailyUsageRollupRepairs
);

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/usage-daily-rollup-repairs', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe('GET /api/cron/usage-daily-rollup-repairs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockProcessPendingDailyUsageRollupRepairs).not.toHaveBeenCalled();
  });

  test('drains the repair queue with a bounded limit and reports success', async () => {
    mockProcessPendingDailyUsageRollupRepairs.mockResolvedValue({
      claimed: 2,
      repaired: 2,
      failed: [],
    });

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      partialFailure: false,
      summary: { claimed: 2, repaired: 2 },
    });
    expect(mockProcessPendingDailyUsageRollupRepairs).toHaveBeenCalledWith(expect.anything(), {
      limit: 20,
    });
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Usage daily rollup repairs completed',
      expect.objectContaining({ claimedCount: 2, repairedCount: 2, failedCount: 0 })
    );
  });

  test('returns failure status and telemetry when a repair fails', async () => {
    mockProcessPendingDailyUsageRollupRepairs.mockResolvedValue({
      claimed: 2,
      repaired: 1,
      failed: [
        {
          usageId: '00000000-0000-4000-8000-000000000001',
          kiloUserId: 'user-3',
          organizationId: null,
          usageDate: '2026-07-13',
          error: 'postgres:55P03',
        },
      ],
    });

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      partialFailure: true,
    });
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Usage daily rollup repairs completed with partial failures',
      expect.objectContaining({ failedCount: 1 })
    );
  });

  test('exports a bounded function duration', () => {
    expect(maxDuration).toBe(300);
  });
});
