import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@/lib/config.server';
import { pruneExpiredAlertDeliveries } from '@/lib/organizations/alerts/alert-deliveries';
import { evaluateMonthlySpendingAlerts } from '@/lib/organizations/alerts/monthly-spending/monthly-spending-evaluator';

/**
 * Hourly evaluation of organization spending alerts. The summary carries stable
 * counts and identifiers only: recipient addresses never reach logs or Sentry.
 */
export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.organization_alerts',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const summary = await evaluateMonthlySpendingAlerts();
    const prunedDeliveryCount = await pruneExpiredAlertDeliveries();

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        evaluated_alert_count: summary.evaluatedAlertCount,
        crossed_alert_count: summary.crossedAlertCount,
        claimed_delivery_count: summary.claimedDeliveryCount,
        invalid_alert_count: summary.invalidAlertCount,
        failed_organization_count: summary.failedOrganizationCount,
        accepted_count: summary.dispatched.accepted,
        ambiguous_count: summary.dispatched.ambiguous,
        failed_count: summary.dispatched.failed,
        canceled_count: summary.dispatched.canceled,
        skipped_count: summary.dispatched.skipped,
        ambiguous_lease_count: summary.ambiguousLeaseCount,
        has_more_alerts: summary.hasMoreAlerts,
        pruned_delivery_count: prunedDeliveryCount,
      })
    );

    return NextResponse.json({
      ...summary,
      prunedDeliveryCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
