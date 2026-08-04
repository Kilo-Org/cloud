import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { processPendingDailyUsageRollupRepairs } from '@/lib/ai-gateway/usage-daily-rollup-repairs';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Drains `microdollar_usage_daily_repairs` and rebuilds the affected
 * `microdollar_usage_daily` rows. Every billable usage row enqueues a repair
 * signal, and a claim coalesces all pending signals for one owner and UTC day,
 * so the limit bounds distinct owner-days rebuilt per run rather than requests.
 *
 * This ran inside the Cost Insights hourly sweep until that feature was retired.
 * The limit and hourly schedule match the previous behaviour.
 */
const DAILY_USAGE_ROLLUP_REPAIR_LIMIT = 20;

export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid usage-daily-rollup-repairs CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await processPendingDailyUsageRollupRepairs(db, {
    limit: DAILY_USAGE_ROLLUP_REPAIR_LIMIT,
  });
  sentryLogger('cron', 'info')('Usage daily rollup repairs completed', {
    claimedCount: summary.claimed,
    repairedCount: summary.repaired,
    failedCount: summary.failed.length,
  });

  const hasFailures = summary.failed.length > 0;
  if (hasFailures) {
    sentryLogger('cron', 'error')('Usage daily rollup repairs completed with partial failures', {
      failedCount: summary.failed.length,
    });
  }

  return NextResponse.json(
    {
      success: !hasFailures,
      partialFailure: hasFailures,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: hasFailures ? 500 : 200 }
  );
}
