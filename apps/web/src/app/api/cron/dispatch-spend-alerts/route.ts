import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { createSpendAlertSweepStore, runSpendAlertSweep } from '@/lib/spend-alerts/sweep';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

/**
 * One spend-alert sweep tick: re-derive the hourly buckets for the usage delta
 * and decide those scopes (plus any rule still firing). The sweep never walks
 * the owner population, so an idle fleet costs a single empty range scan.
 *
 * Delivery runs in its own cron (`drain-spend-alert-deliveries`) so a slow or
 * killed sweep cannot stop the outbox from draining that tick.
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

  const summary = {
    scopesTouched: sweep.candidateScopes,
    alertsFired: sweep.fired,
  };

  sentryLogger('cron', 'info')('Spend alert sweep completed', summary);

  return NextResponse.json({
    success: true,
    summary,
    timestamp: new Date().toISOString(),
  });
}
