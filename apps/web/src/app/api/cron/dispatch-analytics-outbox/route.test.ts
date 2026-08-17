import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/analytics-outbox/dispatch', () => ({
  dispatchQueuedAnalyticsEvents: jest.fn(),
}));

import { dispatchQueuedAnalyticsEvents } from '@/lib/analytics-outbox/dispatch';
import { GET } from './route';

const mockDispatchQueuedAnalyticsEvents = jest.mocked(dispatchQueuedAnalyticsEvents);

describe('GET /api/cron/dispatch-analytics-outbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthorized requests', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-analytics-outbox', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockDispatchQueuedAnalyticsEvents).not.toHaveBeenCalled();
  });

  it('dispatches queued analytics events when authorized', async () => {
    mockDispatchQueuedAnalyticsEvents.mockResolvedValue({
      reclaimed: 1,
      claimed: 3,
      delivered: 2,
      retried: 1,
      failed: 0,
      outboxDeliveredPurged: 1,
      outboxFailedPurged: 0,
      expiredUnsettledLedgerSettled: 1,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-analytics-outbox', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockDispatchQueuedAnalyticsEvents).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        summary: {
          reclaimed: 1,
          claimed: 3,
          delivered: 2,
          retried: 1,
          failed: 0,
          outboxDeliveredPurged: 1,
          outboxFailedPurged: 0,
          expiredUnsettledLedgerSettled: 1,
        },
        timestamp: expect.any(String),
      })
    );
  });
});
