import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@/lib/leaderboard-usage-rollup', () => ({
  buildLeaderboardUsageDays: jest.fn(),
}));
const mockSentryLog = jest.fn();
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => mockSentryLog),
  logExceptInTest: jest.fn(),
  warnExceptInTest: jest.fn(),
}));

import type { LeaderboardUsageBuildSummary } from '@/lib/leaderboard-usage-rollup';
import { buildLeaderboardUsageDays } from '@/lib/leaderboard-usage-rollup';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { GET, maxDuration } from './route';

const mockBuild = jest.mocked(buildLeaderboardUsageDays);

function request(secret: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/cron/leaderboard-usage-rollup', {
    headers: { authorization: `Bearer ${secret}` },
  });
}

function summary(overrides: Partial<LeaderboardUsageBuildSummary> = {}) {
  return {
    built: [
      {
        usageDate: '2026-11-09',
        rows: 42,
        durationMs: 9_000,
        slices: 96,
        slowestSliceMs: 300,
        replayWaitMs: 50,
        conflictRetries: 0,
      },
    ],
    remaining: [],
    unsettled: [],
    emptyDays: [],
    stoppedBy: null,
    yesterdayBuilt: true,
    replicaLagMs: 120,
    durationMs: 9_500,
    ...overrides,
  } satisfies LeaderboardUsageBuildSummary;
}

function loggedLine(logger: jest.Mock): unknown {
  const [line] = logger.mock.calls[0] as [string];
  return JSON.parse(line);
}

describe('GET /api/cron/leaderboard-usage-rollup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockBuild.mockResolvedValue(summary());
  });

  test('rejects invalid cron authorization', async () => {
    const response = await GET(request('wrong-secret'));

    expect(response.status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('builds within a deadline inside the function duration and logs the summary', async () => {
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
    expect(loggedLine(jest.mocked(logExceptInTest))).toEqual({
      type: 'leaderboard_usage_rollup',
      ...summary(),
      yesterdayMissing: false,
    });
    expect(warnExceptInTest).not.toHaveBeenCalled();
    expect(mockSentryLog).not.toHaveBeenCalled();
  });

  test('logs a warning when a built day was empty', async () => {
    mockBuild.mockResolvedValue(summary({ emptyDays: ['2026-11-09'] }));

    await GET(request('cron-secret'));

    expect(loggedLine(jest.mocked(warnExceptInTest))).toMatchObject({
      emptyDays: ['2026-11-09'],
    });
    expect(logExceptInTest).not.toHaveBeenCalled();
  });

  test.each([
    { now: '2026-11-10T02:20:00.000Z', warned: false },
    { now: '2026-11-10T03:20:00.000Z', warned: true },
  ])('warns when yesterday is still missing at 03:00 UTC ($now)', async ({ now, warned }) => {
    jest.useFakeTimers({ now: new Date(now), doNotFake: ['nextTick', 'setImmediate'] });
    mockBuild.mockResolvedValue(summary({ built: [], yesterdayBuilt: false }));

    await GET(request('cron-secret'));

    const logger = jest.mocked(warned ? warnExceptInTest : logExceptInTest);
    expect(loggedLine(logger)).toMatchObject({ yesterdayMissing: warned });
  });
});
