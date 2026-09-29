import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { createSpendAlertSweepStore, runSpendAlertSweep } from '@/lib/spend-alerts/sweep';
import {
  drainPendingSpendAlertDeliveries,
  spendAlertDeliveryDeps,
} from '@/lib/spend-alerts/delivery';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Bounded per-run send fan-out. A crossing enqueues at most one row per channel
 * and rule, and the pending index orders the claim, so the limit bounds alerts
 * sent per run rather than scopes observed.
 */
const SPEND_ALERT_DELIVERY_LIMIT = 50;

export const maxDuration = 300;

/**
 * One spend-alert tick: re-derive the hourly buckets for the usage delta,
 * decide those scopes (plus any rule still firing), then drain the alert
 * outbox. The sweep never walks the owner population, so an idle fleet costs a
 * single empty range scan and an empty claim.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid dispatch-spend-alerts CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sweep = await runSpendAlertSweep(
    db,
    { store: createSpendAlertSweepStore(db) },
    { now: new Date() }
  );
  const deliveries = await drainPendingSpendAlertDeliveries(db, spendAlertDeliveryDeps, {
    limit: SPEND_ALERT_DELIVERY_LIMIT,
  });

  const summary = {
    scopesTouched: sweep.candidateScopes,
    alertsFired: sweep.fired,
    delivered: deliveries.delivered,
    failed: deliveries.failed.length,
  };

  sentryLogger('cron', 'info')('Spend alert sweep and delivery drain completed', summary);

  const hasFailures = summary.failed > 0;
  if (hasFailures) {
    sentryLogger('cron', 'error')('Spend alert delivery completed with partial failures', {
      failedCount: summary.failed,
      failures: deliveries.failed,
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
