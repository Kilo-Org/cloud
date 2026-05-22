import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/code-reviews/review-memory/aggregation', () => ({
  dispatchReviewMemoryAggregationCron: jest.fn(),
}));

import { dispatchReviewMemoryAggregationCron } from '@/lib/code-reviews/review-memory/aggregation';
import { GET } from './route';

const mockDispatchReviewMemoryAggregationCron = jest.mocked(dispatchReviewMemoryAggregationCron);

describe('GET /api/cron/aggregate-review-memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects unauthorized requests', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/aggregate-review-memory', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockDispatchReviewMemoryAggregationCron).not.toHaveBeenCalled();
  });

  it('dispatches review memory aggregation when authorized', async () => {
    mockDispatchReviewMemoryAggregationCron.mockResolvedValue({
      claimed: 2,
      completed: 1,
      skipped: 1,
      failed: 0,
      proposals: 3,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/aggregate-review-memory', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockDispatchReviewMemoryAggregationCron).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        success: true,
        summary: {
          claimed: 2,
          completed: 1,
          skipped: 1,
          failed: 0,
          proposals: 3,
        },
        timestamp: expect.any(String),
      })
    );
  });
});
