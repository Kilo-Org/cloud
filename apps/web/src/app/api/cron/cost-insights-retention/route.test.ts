import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/cost-insights/jobs', () => ({
  runCostInsightEventRetentionCleanup: jest.fn(),
}));
const mockSentryLog = jest.fn();
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => mockSentryLog) }));

import { runCostInsightEventRetentionCleanup } from '@/lib/cost-insights/jobs';
import { GET } from './route';

const mockRunCostInsightEventRetentionCleanup = jest.mocked(runCostInsightEventRetentionCleanup);

describe('GET /api/cron/cost-insights-retention', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/cost-insights-retention', {
        headers: { authorization: 'Bearer wrong-secret' },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockRunCostInsightEventRetentionCleanup).not.toHaveBeenCalled();
  });

  test('runs retention cleanup for valid cron authorization', async () => {
    mockRunCostInsightEventRetentionCleanup.mockResolvedValue({
      deletedEvents: 3,
      cutoff: '2026-04-07T00:00:00.000Z',
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/cost-insights-retention', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { deletedEvents: 3 },
    });
    expect(mockRunCostInsightEventRetentionCleanup).toHaveBeenCalledTimes(1);
  });
});
