import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/affiliate-events', () => ({
  dispatchQueuedAffiliateEvents: jest.fn(),
}));

import { dispatchQueuedAffiliateEvents } from '@/lib/affiliate-events';
import { GET } from './route';

const mockDispatchQueuedAffiliateEvents = jest.mocked(dispatchQueuedAffiliateEvents);

describe('GET /api/cron/dispatch-affiliate-events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthorized requests', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-affiliate-events', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockDispatchQueuedAffiliateEvents).not.toHaveBeenCalled();
  });

  it('dispatches queued affiliate events when authorized', async () => {
    mockDispatchQueuedAffiliateEvents.mockResolvedValue({
      reclaimed: 1,
      claimed: 3,
      delivered: 2,
      retried: 1,
      failed: 0,
      unblocked: 1,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-affiliate-events', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockDispatchQueuedAffiliateEvents).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        summary: {
          reclaimed: 1,
          claimed: 3,
          delivered: 2,
          retried: 1,
          failed: 0,
          unblocked: 1,
        },
        timestamp: expect.any(String),
      })
    );
  });
});
