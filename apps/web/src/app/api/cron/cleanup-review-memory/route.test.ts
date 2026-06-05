import { NextRequest } from 'next/server';

const mockPruneExpiredReviewMemoryData = jest.fn();

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/code-reviews/review-memory/db', () => ({
  pruneExpiredReviewMemoryData: () => mockPruneExpiredReviewMemoryData(),
}));

import { GET } from './route';

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-review-memory', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-review-memory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects requests without cron authorization', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockPruneExpiredReviewMemoryData).not.toHaveBeenCalled();
  });

  it('rejects requests with invalid cron authorization', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockPruneExpiredReviewMemoryData).not.toHaveBeenCalled();
  });

  it('prunes review memory data when authorized', async () => {
    mockPruneExpiredReviewMemoryData.mockResolvedValue({
      cutoff: '2026-05-14T00:00:00.000Z',
      proposalsDeleted: 1,
      feedbackEventsDeleted: 3,
      subjectsDeleted: 4,
      aggregationStatesDeleted: 5,
    });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(mockPruneExpiredReviewMemoryData).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: {
        cutoff: '2026-05-14T00:00:00.000Z',
        proposalsDeleted: 1,
        feedbackEventsDeleted: 3,
        subjectsDeleted: 4,
        aggregationStatesDeleted: 5,
      },
      timestamp: expect.any(String),
    });
  });
});
