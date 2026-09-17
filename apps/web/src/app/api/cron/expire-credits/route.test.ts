import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/credit-expiration-cron', () => ({
  runExpireCreditsCron: jest.fn(),
}));

import { runExpireCreditsCron } from '@/lib/credit-expiration-cron';
import { GET, maxDuration } from './route';

const mockRunExpireCreditsCron = jest.mocked(runExpireCreditsCron);

describe('GET /api/cron/expire-credits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports maxDuration of 60 seconds', () => {
    expect(maxDuration).toBe(60);
  });

  it('rejects unauthorized requests', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/cron/expire-credits'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockRunExpireCreditsCron).not.toHaveBeenCalled();
  });

  it('expires due credits when authorized', async () => {
    mockRunExpireCreditsCron.mockResolvedValue({
      usersExamined: 2,
      usersFailed: 0,
      organizationsExamined: 1,
      organizationsFailed: 0,
      hasMore: false,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/expire-credits', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockRunExpireCreditsCron).toHaveBeenCalledWith();
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.summary).toEqual({
      usersExamined: 2,
      usersFailed: 0,
      organizationsExamined: 1,
      organizationsFailed: 0,
      hasMore: false,
    });
  });

  it('returns HTTP 500 when expiration fails', async () => {
    mockRunExpireCreditsCron.mockResolvedValue({
      usersExamined: 1,
      usersFailed: 1,
      organizationsExamined: 0,
      organizationsFailed: 0,
      hasMore: false,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/expire-credits', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });
});
