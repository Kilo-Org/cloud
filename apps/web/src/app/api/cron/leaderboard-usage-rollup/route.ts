import { NextResponse } from 'next/server';

import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { buildLeaderboardUsageDays } from '@/lib/leaderboard-usage-rollup';
import {
  logExceptInTest,
  sentryLogger,
  warnExceptInTest,
} from '@kilocode/web-shared/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 800;

// Leaves room for the day in progress to finish inside `maxDuration`.
const BUILD_BUDGET_MS = 500_000;

// Yesterday settles at 01:00 UTC; still missing two hours later means runs are failing.
const YESTERDAY_MISSING_AFTER_UTC_HOUR = 3;

/**
 * Hourly build of `leaderboard_usage_daily` for the public leaderboard routes.
 * Each run fills the days in the leaderboard window that have no rollup yet, so
 * a new day lands within an hour of UTC midnight and a failed run is retried by
 * the next one.
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

  const now = new Date();
  const summary = await buildLeaderboardUsageDays({
    readDb,
    db,
    now,
    deadline: Date.now() + BUILD_BUDGET_MS,
  });

  // Console only: these logs are for investigating, not alerting.
  const yesterdayMissing =
    !summary.yesterdayBuilt && now.getUTCHours() >= YESTERDAY_MISSING_AFTER_UTC_HOUR;
  const log = summary.emptyDays.length > 0 || yesterdayMissing ? warnExceptInTest : logExceptInTest;
  log(JSON.stringify({ type: 'leaderboard_usage_rollup', ...summary, yesterdayMissing }));

  return NextResponse.json({
    success: true,
    summary,
    timestamp: new Date().toISOString(),
  });
}
