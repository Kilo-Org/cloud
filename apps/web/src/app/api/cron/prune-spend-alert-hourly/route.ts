import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import {
  pruneSpendAlertHourly,
  SPEND_ALERT_HOURLY_RETENTION_DAYS,
} from '@/lib/spend-alerts/retention';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

/**
 * Daily retention prune for the spend-alert hourly rollup. Deletes buckets older
 * than the retention window in bounded batches, so one run cannot hold a long
 * lock on `spend_alert_hourly`.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid prune-spend-alert-hourly CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { deleted } = await pruneSpendAlertHourly(db, { now: new Date() });

  const summary = {
    deleted,
    retentionDays: SPEND_ALERT_HOURLY_RETENTION_DAYS,
  };

  sentryLogger('cron', 'info')('Spend alert hourly retention prune completed', summary);

  return NextResponse.json({
    success: true,
    summary,
    timestamp: new Date().toISOString(),
  });
}
