import { NextResponse } from 'next/server';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { buildLeaderboardUsageHours } from '@/lib/leaderboard-usage-hourly-rollup';
import {
  logExceptInTest,
  sentryLogger,
  warnExceptInTest,
} from '@kilocode/web-shared/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

// Leaves room for the slice in progress (60s statement timeout) and the hour's
// write to finish inside `maxDuration`.
const BUILD_BUDGET_MS = 200_000;

/**
 * Builds `leaderboard_usage_hourly` for the public leaderboard routes. Each run
 * fills the recent settled hours that are not built yet, reading the primary
 * while that usage is still warm, so a failed run is retried by the next one.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid leaderboard-usage-hourly-rollup CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await buildLeaderboardUsageHours({
    db,
    now: new Date(),
    deadline: Date.now() + BUILD_BUDGET_MS,
  });

  // Console only: these logs are for investigating, not alerting.
  const log = summary.failed.length > 0 || summary.stoppedBy ? warnExceptInTest : logExceptInTest;
  log(JSON.stringify({ type: 'leaderboard_usage_rollup', ...summary }));

  return NextResponse.json({
    success: true,
    summary,
    timestamp: new Date().toISOString(),
  });
}
