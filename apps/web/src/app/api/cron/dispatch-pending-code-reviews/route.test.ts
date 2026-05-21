import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/code-reviews/dispatch/dispatch-pending-code-review-owners', () => ({
  dispatchPendingCodeReviewOwners: jest.fn(),
}));

import { dispatchPendingCodeReviewOwners } from '@/lib/code-reviews/dispatch/dispatch-pending-code-review-owners';
import { GET } from './route';

const mockDispatchPendingCodeReviewOwners = jest.mocked(dispatchPendingCodeReviewOwners);

describe('GET /api/cron/dispatch-pending-code-reviews', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects requests without cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-pending-code-reviews', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockDispatchPendingCodeReviewOwners).not.toHaveBeenCalled();
  });

  it('rejects requests with invalid cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-pending-code-reviews', {
        method: 'GET',
        headers: { authorization: 'Bearer wrong-secret' },
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockDispatchPendingCodeReviewOwners).not.toHaveBeenCalled();
  });

  it('dispatches pending code-review owners when authorized', async () => {
    mockDispatchPendingCodeReviewOwners.mockResolvedValue({
      ownersConsidered: 4,
      ownersProcessed: 3,
      ownersWithNoNewDispatch: 1,
      ownersSkippedMissingBotUsers: 1,
      coordinatorFailures: 0,
      reviewsDispatched: 5,
      hasMoreCandidateOwners: true,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/dispatch-pending-code-reviews', {
        method: 'GET',
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockDispatchPendingCodeReviewOwners).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: {
        ownersConsidered: 4,
        ownersProcessed: 3,
        ownersWithNoNewDispatch: 1,
        ownersSkippedMissingBotUsers: 1,
        coordinatorFailures: 0,
        reviewsDispatched: 5,
        hasMoreCandidateOwners: true,
      },
      timestamp: expect.any(String),
    });
  });
});
