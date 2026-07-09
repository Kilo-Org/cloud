import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { runCostInsightHourlySweep } from '@/lib/cost-insights/jobs';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid cost-insights-hourly CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await runCostInsightHourlySweep(db);
  sentryLogger('cron', 'info')('Cost Insights hourly sweep completed', {
    evaluatedOwnerCount: summary.evaluatedOwners,
    failedOwnerCount: summary.failedOwners.length,
    dirtyQueueDepthBefore: summary.dirtyQueueDepthBefore,
    dirtyQueueDepthAfter: summary.dirtyQueueDepthAfter,
    dirtyClaimedCount: summary.dirtyEvaluations.claimed,
    evaluationDurationMs: summary.evaluationDurationMs,
    rawCanonicalFallbackCount: summary.rawCanonicalFallbackCount,
    rollupDegradedIntervalCount: summary.rollupDegradedIntervalCount,
    notificationClaimedCount: summary.notifications.claimed,
    deadlineReached: summary.deadlineReached,
    ownerCycleComplete: summary.ownerCycleComplete,
    alreadyRunning: summary.alreadyRunning,
  });
  const hasFailures =
    summary.failedOwners.length > 0 ||
    summary.notifications.failed > 0 ||
    summary.notifications.terminalized > 0;
  if (hasFailures) {
    sentryLogger('cron', 'error')('Cost Insights hourly sweep completed with partial failures', {
      failedOwnerCount: summary.failedOwners.length,
      failedNotificationCount: summary.notifications.failed,
      terminalizedNotificationCount: summary.notifications.terminalized,
    });
  }

  return NextResponse.json(
    {
      success: !hasFailures,
      partialFailure: hasFailures,
      complete: summary.ownerCycleComplete,
      deadlineReached: summary.deadlineReached,
      alreadyRunning: summary.alreadyRunning,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: hasFailures ? 500 : 200 }
  );
}
