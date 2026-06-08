import '@/lib/load-env';

import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { KILOCLAW_COMMIT_SALES_CUTOFF, isBeforeKiloClawCommitSalesCutoff } from '@kilocode/db';
import { kiloclaw_subscription_change_log, kiloclaw_subscriptions } from '@kilocode/db/schema';
import { and, inArray, isNull, sql } from 'drizzle-orm';

const LIVE_STATUSES = ['active', 'past_due', 'unpaid'] as const;

type InventorySubscription = typeof kiloclaw_subscriptions.$inferSelect;
type PendingSwitchEvidence = { requestedAt: string | null; issue: string | null };

function normalizedTimestamp(value: string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

async function getPendingSwitchEvidence(subscriptionId: string): Promise<PendingSwitchEvidence> {
  const { rows } = await db.execute<{ requested_at: string }>(sql`
    SELECT created_at AS requested_at
    FROM ${kiloclaw_subscription_change_log}
    WHERE subscription_id = ${subscriptionId}
      AND action = 'schedule_changed'
      AND after_state->>'scheduled_plan' = 'commit'
      AND COALESCE(before_state->>'scheduled_plan', '') <> 'commit'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  const requestedAt = rows[0]?.requested_at;
  if (!requestedAt) return { requestedAt: null, issue: 'missing_switch_request_change_log' };

  const normalizedRequestedAt = new Date(requestedAt).toISOString();
  return {
    requestedAt: normalizedRequestedAt,
    issue: isBeforeKiloClawCommitSalesCutoff(normalizedRequestedAt)
      ? null
      : 'switch_request_not_before_cutoff',
  };
}

function commitIssues(subscription: InventorySubscription): string[] {
  const issues: string[] = [];
  const finalBoundary = normalizedTimestamp(subscription.commit_ends_at);
  const periodEnd = normalizedTimestamp(subscription.current_period_end);

  if (!finalBoundary) issues.push('missing_commit_ends_at');
  if (finalBoundary && periodEnd && finalBoundary < periodEnd) {
    issues.push('commit_boundary_before_current_period_end');
  }
  if (subscription.scheduled_plan === 'commit') {
    issues.push('commit_row_also_schedules_commit');
  }
  if (subscription.scheduled_plan === 'standard' && subscription.scheduled_by !== 'user') {
    issues.push('standard_continuation_without_user_actor');
  }
  if (
    subscription.status === 'active' &&
    subscription.scheduled_plan !== 'standard' &&
    !subscription.cancel_at_period_end
  ) {
    issues.push('final_commit_still_renewing');
  }

  return issues;
}

async function main() {
  if (process.argv.includes('--run-actually')) throw new Error('audit_script_is_read_only');

  const { rows: nowRows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  const databaseNow = nowRows[0]?.now ? new Date(nowRows[0].now).toISOString() : null;
  if (!databaseNow) throw new Error('database_now_unavailable');

  const subscriptions = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(
      and(
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        inArray(kiloclaw_subscriptions.status, [...LIVE_STATUSES])
      )
    );
  const commitSubscriptions = subscriptions.filter(subscription => subscription.plan === 'commit');
  const pendingCommitSwitches = subscriptions.filter(
    subscription => subscription.plan === 'standard' && subscription.scheduled_plan === 'commit'
  );

  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_retirement_audit_started',
      mode: 'dry_run_read_only',
      databaseNow,
      cutoff: KILOCLAW_COMMIT_SALES_CUTOFF,
    })
  );

  let anomalyCount = 0;
  for (const subscription of commitSubscriptions) {
    const issues = commitIssues(subscription);
    anomalyCount += issues.length > 0 ? 1 : 0;
    console.log(
      JSON.stringify({
        event: 'kiloclaw_commit_retirement_commit_subscription',
        subscriptionId: subscription.id,
        status: subscription.status,
        paymentSource: subscription.payment_source,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        finalBoundary: normalizedTimestamp(subscription.commit_ends_at),
        scheduledPlan: subscription.scheduled_plan,
        scheduledBy: subscription.scheduled_by,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        issues,
      })
    );
  }

  for (const subscription of pendingCommitSwitches) {
    const evidence = await getPendingSwitchEvidence(subscription.id);
    const issues = evidence.issue ? [evidence.issue] : [];
    anomalyCount += issues.length > 0 ? 1 : 0;
    console.log(
      JSON.stringify({
        event: 'kiloclaw_commit_retirement_pending_commit_switch',
        subscriptionId: subscription.id,
        status: subscription.status,
        switchRequestedAt: evidence.requestedAt,
        issues,
      })
    );
  }

  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_retirement_audit_completed',
      activeCommitSubscriptions: commitSubscriptions.length,
      pendingStandardToCommitSwitches: pendingCommitSwitches.length,
      subscriptionsWithAnomalies: anomalyCount,
    })
  );
}

void main()
  .catch(error => {
    console.error(
      JSON.stringify({
        event: 'kiloclaw_commit_retirement_audit_failed',
        error: error instanceof Error ? error.name : 'UnknownError',
      })
    );
    process.exitCode = 1;
  })
  .finally(() => closeAllDrizzleConnections());
