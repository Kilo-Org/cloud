import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/user/deletion-queue/deletion-worker', () => ({
  runUserDeletionWorker: jest.fn(),
}));

import { runUserDeletionWorker } from '@/lib/user/deletion-queue/deletion-worker';
import { GET, maxDuration } from './route';

const mockRunUserDeletionWorker = jest.mocked(runUserDeletionWorker);

describe('GET /api/cron/process-user-deletions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports maxDuration of 60 seconds', () => {
    expect(maxDuration).toBe(60);
  });

  it('rejects unauthorized requests', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/process-user-deletions', {
        method: 'GET',
      })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockRunUserDeletionWorker).not.toHaveBeenCalled();
  });

  it('runs the deletion worker when authorized', async () => {
    mockRunUserDeletionWorker.mockResolvedValue({
      outcome: 'success',
      processed: 4,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/process-user-deletions', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret',
        },
      })
    );

    expect(response.status).toBe(200);
    expect(mockRunUserDeletionWorker).toHaveBeenCalledWith();
    await expect(response.json()).resolves.toEqual({
      success: true,
      outcome: 'success',
      processed: 4,
    });
  });

  it('returns HTTP 500 when the worker reports failure', async () => {
    mockRunUserDeletionWorker.mockResolvedValue({
      outcome: 'failure',
      processed: 1,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/process-user-deletions', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret',
        },
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      outcome: 'failure',
      processed: 1,
    });
  });
});
