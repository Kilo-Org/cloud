import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/leaderboard-usage-hourly-rollup', () => ({
  buildLeaderboardUsageHours: jest.fn(),
}));
const mockSentryLog = jest.fn();
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => mockSentryLog),
  logExceptInTest: jest.fn(),
  warnExceptInTest: jest.fn(),
}));

import type { LeaderboardUsageBuildSummary } from '@/lib/leaderboard-usage-hourly-rollup';
import { buildLeaderboardUsageHours } from '@/lib/leaderboard-usage-hourly-rollup';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { GET, maxDuration } from './route';

const mockBuild = jest.mocked(buildLeaderboardUsageHours);

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/leaderboard-usage-hourly-rollup', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function summary(overrides: Partial<LeaderboardUsageBuildSummary> = {}) {
  return {
    built: [
      {
        hourStart: '2026-11-10T08:00:00.000Z',
        rows: 42,
        durationMs: 2_500,
        slices: 12,
        slowestSliceMs: 300,
      },
    ],
    failed: [],
    overBudget: [],
    remaining: [],
    stoppedBy: null,
    durationMs: 2_600,
    ...overrides,
  } satisfies LeaderboardUsageBuildSummary;
}

function loggedLine(logger: jest.Mock): unknown {
  const [line] = logger.mock.calls[0] as [string];
  return JSON.parse(line);
}

describe('GET /api/cron/leaderboard-usage-hourly-rollup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuild.mockResolvedValue(summary());
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('builds on the primary within a deadline inside the function duration', async () => {
    const before = Date.now();
    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      summary: { built: [{ hourStart: '2026-11-10T08:00:00.000Z', rows: 42 }], remaining: [] },
    });
    const [options] = mockBuild.mock.calls[0];
    expect(options.db).toBe(db);
    expect(options.deadline).toBeGreaterThan(before);
    expect(options.deadline).toBeLessThan(before + maxDuration * 1000 - 60_000);
    expect(loggedLine(jest.mocked(logExceptInTest))).toEqual({
      type: 'leaderboard_usage_rollup',
      ...summary(),
    });
    expect(warnExceptInTest).not.toHaveBeenCalled();
    expect(mockSentryLog).not.toHaveBeenCalled();
  });

  test('logs a warning when the run stopped at its deadline', async () => {
    mockBuild.mockResolvedValue(
      summary({ remaining: ['2026-11-10T09:00:00.000Z'], stoppedBy: 'deadline' })
    );

    await GET(request('cron-secret'));

    expect(loggedLine(jest.mocked(warnExceptInTest))).toMatchObject({
      remaining: ['2026-11-10T09:00:00.000Z'],
      stoppedBy: 'deadline',
    });
    expect(logExceptInTest).not.toHaveBeenCalled();
  });

  test('logs a warning when an hour failed', async () => {
    mockBuild.mockResolvedValue(summary({ failed: ['2026-11-10T07:00:00.000Z'] }));

    const response = await GET(request('cron-secret'));

    expect(response.status).toBe(200);
    expect(loggedLine(jest.mocked(warnExceptInTest))).toMatchObject({
      failed: ['2026-11-10T07:00:00.000Z'],
    });
    expect(mockSentryLog).not.toHaveBeenCalled();
  });
});
