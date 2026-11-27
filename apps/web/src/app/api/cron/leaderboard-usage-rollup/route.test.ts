import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/leaderboard-usage-rollup', () => ({
  buildLeaderboardUsageDays: jest.fn(),
}));
const mockSentryLog = jest.fn();
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => mockSentryLog),
}));

import { buildLeaderboardUsageDays } from '@/lib/leaderboard-usage-rollup';
import { GET, maxDuration } from './route';

const mockBuild = jest.mocked(buildLeaderboardUsageDays);

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/leaderboard-usage-rollup', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe('GET /api/cron/leaderboard-usage-rollup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuild.mockResolvedValue({
      built: [{ usageDate: '2026-11-09', rows: 42 }],
      remaining: [],
    });
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('builds missing days within a deadline inside the function duration', async () => {
    const before = Date.now();
    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { built: [{ usageDate: '2026-11-09', rows: 42 }], remaining: [] },
    });
    const [options] = mockBuild.mock.calls[0];
    expect(options.deadline).toBeGreaterThan(before);
    expect(options.deadline).toBeLessThan(before + maxDuration * 1000);
    expect(mockSentryLog).toHaveBeenCalledWith(
      'Leaderboard usage rollup completed',
      expect.objectContaining({ remaining: [] })
    );
  });
});
