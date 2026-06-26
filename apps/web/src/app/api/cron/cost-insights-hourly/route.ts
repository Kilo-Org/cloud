import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { runCostInsightHourlySweep } from '@/lib/cost-insights/jobs';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
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
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: hasFailures ? 500 : 200 }
  );
}
