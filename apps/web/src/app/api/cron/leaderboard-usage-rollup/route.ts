import { NextResponse } from 'next/server';

import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { buildLeaderboardUsageDays } from '@/lib/leaderboard-usage-rollup';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 800;

// Leaves room for the day in progress to finish inside `maxDuration`.
const BUILD_BUDGET_MS = 500_000;

/**
 * Hourly build of `leaderboard_usage_daily` for the public leaderboard routes.
 * Each run fills the days in the leaderboard window that have no rollup yet, so
 * a new day lands within an hour of UTC midnight and a failed run is retried by
 * the next one. Runs in the early UTC hours also rebuild yesterday to pick up
 * usage rows that reached the database late.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid leaderboard-usage-rollup CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await buildLeaderboardUsageDays({
    readDb,
    db,
    now: new Date(),
    deadline: Date.now() + BUILD_BUDGET_MS,
  });

  sentryLogger('cron', 'info')('Leaderboard usage rollup completed', summary);

  return NextResponse.json({
    success: true,
    summary,
    timestamp: new Date().toISOString(),
  });
}
