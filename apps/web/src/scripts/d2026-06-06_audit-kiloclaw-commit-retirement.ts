import '@/lib/load-env';

import { closeAllDrizzleConnections, db } from '@/lib/drizzle';
import { client as stripe } from '@/lib/stripe-client';
import { getClawPlanForStripePriceId } from '@/lib/kiloclaw/stripe-price-ids.server';
import {
  KILOCLAW_COMMIT_SALES_CUTOFF,
  KiloClawCommitRetirementReviewCaseStatus,
  classifyKiloClawCommitTerm,
  deriveKiloClawCommitFinalBoundary,
  isBeforeKiloClawCommitSalesCutoff,
} from '@kilocode/db';
import {
  kiloclaw_commit_retirement_review_cases,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type Stripe from 'stripe';

const LIVE_STATUSES = ['active', 'past_due', 'unpaid'] as const;

type InventorySubscription = typeof kiloclaw_subscriptions.$inferSelect;
type ScheduleEvidence = {
  status: string;
  providerPeriodEnd: string | null;
  issue: string | null;
};
type CheckoutCounts = { directCommit: number; kiloPassCommitIntents: number };
type PendingSwitchEvidence = { requestedAt: string | null; issue: string | null };

function stripeSubscriptionPeriodEnd(subscription: Stripe.Subscription): string | null {
  const periodEnd = subscription.items.data[0]?.current_period_end;
  return typeof periodEnd === 'number' ? new Date(periodEnd * 1000).toISOString() : null;
}

function scheduleCommitPricePhaseCount(schedule: Stripe.SubscriptionSchedule): number {
  return schedule.phases.filter(phase =>
    phase.items.some(item => {
      const priceId = typeof item.price === 'string' ? item.price : item.price.id;
      return getClawPlanForStripePriceId(priceId) === 'commit';
    })
  ).length;
}

async function inspectProviderEvidence(
  subscription: InventorySubscription
): Promise<ScheduleEvidence> {
  if (!subscription.stripe_subscription_id) {
    return { status: 'not_stripe_funded', providerPeriodEnd: null, issue: null };
  }

  try {
    const providerSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id
    );
    const providerPeriodEnd = stripeSubscriptionPeriodEnd(providerSubscription);
    const attachedScheduleId =
      typeof providerSubscription.schedule === 'string'
        ? providerSubscription.schedule
        : providerSubscription.schedule?.id;
    const scheduleId = subscription.stripe_schedule_id ?? attachedScheduleId;

    if (subscription.stripe_schedule_id && attachedScheduleId !== subscription.stripe_schedule_id) {
      return {
        status: providerSubscription.status,
        providerPeriodEnd,
        issue: 'schedule_pointer_mismatch',
      };
    }

    if (!scheduleId) {
      return { status: providerSubscription.status, providerPeriodEnd, issue: null };
    }

    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    if (scheduleCommitPricePhaseCount(schedule) > 1) {
      return {
        status: providerSubscription.status,
        providerPeriodEnd,
        issue: 'multiple_commit_schedule_phases',
      };
    }

    return { status: providerSubscription.status, providerPeriodEnd, issue: null };
  } catch (error) {
    return {
      status: 'provider_read_failed',
      providerPeriodEnd: null,
      issue: error instanceof Error ? error.name : 'UnknownError',
    };
  }
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

async function countOpenCommitCheckouts(): Promise<CheckoutCounts> {
  let directCommit = 0;
  let kiloPassCommitIntents = 0;

  for await (const summary of stripe.checkout.sessions.list({ status: 'open', limit: 100 })) {
    const session = await stripe.checkout.sessions.retrieve(summary.id, { expand: ['line_items'] });
    const priceId = session.line_items?.data[0]?.price?.id;

    if (
      session.metadata?.type === 'kiloclaw' &&
      (session.metadata.plan === 'commit' || getClawPlanForStripePriceId(priceId) === 'commit')
    ) {
      directCommit++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_retirement_open_direct_checkout',
          checkoutSessionId: session.id,
          createdAt: new Date(session.created * 1000).toISOString(),
        })
      );
    } else if (
      session.metadata?.type === 'kilo-pass' &&
      (session.metadata.clawHostingPlan === 'commit' ||
        session.metadata.kiloclawHostingPlan === 'commit')
    ) {
      kiloPassCommitIntents++;
      console.log(
        JSON.stringify({
          event: 'kiloclaw_commit_retirement_pending_kilo_pass_intent',
          checkoutSessionId: session.id,
          createdAt: new Date(session.created * 1000).toISOString(),
        })
      );
    }
  }

  return { directCommit, kiloPassCommitIntents };
}

async function main() {
  if (process.argv.includes('--run-actually')) {
    throw new Error('audit_script_is_read_only');
  }

  const { rows: nowRows } = await db.execute<{ now: string }>(sql`SELECT now() AS now`);
  const databaseNow = nowRows[0]?.now ? new Date(nowRows[0].now).toISOString() : null;
  if (!databaseNow) throw new Error('database_now_unavailable');

  const subscriptions = await db
    .select({ subscription: kiloclaw_subscriptions })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        isNull(kiloclaw_instances.organization_id),
        inArray(kiloclaw_subscriptions.status, [...LIVE_STATUSES])
      )
    )
    .then(rows => rows.map(row => row.subscription));

  const commitSubscriptions = subscriptions.filter(subscription => subscription.plan === 'commit');
  const pendingCommitSwitches = subscriptions.filter(
    subscription => subscription.plan === 'standard' && subscription.scheduled_plan === 'commit'
  );
  const dunningRecoveryCandidates = commitSubscriptions.filter(
    subscription =>
      (subscription.status === 'past_due' || subscription.status === 'unpaid') &&
      (subscription.current_period_end !== null
        ? isBeforeKiloClawCommitSalesCutoff(subscription.current_period_end)
        : subscription.credit_renewal_at !== null &&
          isBeforeKiloClawCommitSalesCutoff(subscription.credit_renewal_at))
  );

  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_retirement_audit_started',
      mode: 'dry_run_read_only',
      databaseNow,
      cutoff: KILOCLAW_COMMIT_SALES_CUTOFF,
    })
  );

  let ambiguousEvidence = 0;
  for (const subscription of [...commitSubscriptions, ...pendingCommitSwitches]) {
    const pendingSwitchEvidence =
      subscription.plan === 'standard' ? await getPendingSwitchEvidence(subscription.id) : null;
    const classification =
      pendingSwitchEvidence?.issue === null
        ? 'pending_final_term'
        : classifyKiloClawCommitTerm({
            plan: subscription.plan,
            scheduledPlan: subscription.scheduled_plan,
            currentPeriodStart: subscription.current_period_start,
            currentPeriodEnd: subscription.current_period_end,
            retirementState: subscription.commit_retirement_state,
            finalEndsAt: subscription.commit_retirement_final_ends_at,
            standardOptedInAt: subscription.commit_retirement_standard_opted_in_at,
          });
    const provider = await inspectProviderEvidence(subscription);
    const boundary = deriveKiloClawCommitFinalBoundary({
      durableFinalEndsAt: subscription.commit_retirement_final_ends_at,
      localPeriodEndsAt: subscription.current_period_end,
      providerPeriodEndsAt: provider.providerPeriodEnd,
    });
    const issues = [
      classification === 'ambiguous' ? 'ambiguous_retirement_classification' : null,
      boundary.kind === 'missing' ? 'missing_period_boundary_evidence' : null,
      boundary.kind === 'conflicting' ? 'conflicting_period_boundary_evidence' : null,
      provider.issue,
      pendingSwitchEvidence?.issue ?? null,
    ].filter((issue): issue is string => issue !== null);

    if (issues.length > 0) ambiguousEvidence++;
    console.log(
      JSON.stringify({
        event:
          subscription.plan === 'commit'
            ? 'kiloclaw_commit_retirement_active_commit'
            : 'kiloclaw_commit_retirement_pending_commit_switch',
        subscriptionId: subscription.id,
        status: subscription.status,
        paymentSource: subscription.payment_source,
        classification,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        switchRequestedAt: pendingSwitchEvidence?.requestedAt ?? null,
        qualificationAuthority:
          subscription.plan === 'standard' ? 'subscription_change_log' : 'current_period',
        finalBoundary: boundary.kind === 'verified' ? boundary.finalEndsAt : null,
        boundaryEvidence: boundary.kind,
        providerStatus: provider.status,
        issues,
      })
    );
  }

  for (const subscription of dunningRecoveryCandidates) {
    console.log(
      JSON.stringify({
        event: 'kiloclaw_commit_retirement_pre_cutoff_dunning_recovery_candidate',
        subscriptionId: subscription.id,
        status: subscription.status,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        creditRenewalAt: subscription.credit_renewal_at,
      })
    );
  }

  const openReviewCases = await db
    .select({
      id: kiloclaw_commit_retirement_review_cases.id,
      subscriptionId: kiloclaw_commit_retirement_review_cases.subscription_id,
      reasonCode: kiloclaw_commit_retirement_review_cases.reason_code,
      createdAt: kiloclaw_commit_retirement_review_cases.created_at,
    })
    .from(kiloclaw_commit_retirement_review_cases)
    .where(
      eq(
        kiloclaw_commit_retirement_review_cases.status,
        KiloClawCommitRetirementReviewCaseStatus.Open
      )
    );

  for (const reviewCase of openReviewCases) {
    console.log(
      JSON.stringify({
        event: 'kiloclaw_commit_retirement_open_review_case',
        reviewCaseId: reviewCase.id,
        subscriptionId: reviewCase.subscriptionId,
        reasonCode: reviewCase.reasonCode,
        createdAt: reviewCase.createdAt,
      })
    );
  }

  const checkoutCounts = await countOpenCommitCheckouts();
  console.log(
    JSON.stringify({
      event: 'kiloclaw_commit_retirement_audit_completed',
      activeCommitSubscriptions: commitSubscriptions.length,
      pendingStandardToCommitSwitches: pendingCommitSwitches.length,
      preCutoffDunningRecoveryCandidates: dunningRecoveryCandidates.length,
      openDirectCommitCheckouts: checkoutCounts.directCommit,
      pendingKiloPassCommitIntents: checkoutCounts.kiloPassCommitIntents,
      missingOrConflictingEvidence: ambiguousEvidence,
      openRetirementReviewCases: openReviewCases.length,
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
