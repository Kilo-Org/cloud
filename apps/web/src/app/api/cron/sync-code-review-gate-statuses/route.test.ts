import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/code-reviews/gate-sync', () => ({
  syncDueCodeReviewGateStatuses: jest.fn(),
}));

import { syncDueCodeReviewGateStatuses } from '@/lib/code-reviews/gate-sync';
import { GET } from './route';

const mockSyncDueCodeReviewGateStatuses = jest.mocked(syncDueCodeReviewGateStatuses);

describe('GET /api/cron/sync-code-review-gate-statuses', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects requests without cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/sync-code-review-gate-statuses', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockSyncDueCodeReviewGateStatuses).not.toHaveBeenCalled();
  });

  it('processes due gate sync rows when authorized', async () => {
    mockSyncDueCodeReviewGateStatuses.mockResolvedValue({
      attempted: 3,
      synchronized: 1,
      skipped: 0,
      retried: 2,
      permissionBlocked: 1,
      deferred: 0,
      failed: 0,
      hasMore: false,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/sync-code-review-gate-statuses', {
        method: 'GET',
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockSyncDueCodeReviewGateStatuses).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      success: true,
      summary: {
        attempted: 3,
        synchronized: 1,
        skipped: 0,
        retried: 2,
        permissionBlocked: 1,
        deferred: 0,
        failed: 0,
        hasMore: false,
      },
      timestamp: expect.any(String),
    });
  });
});
