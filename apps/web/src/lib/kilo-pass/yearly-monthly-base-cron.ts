import 'server-only';

import { kilo_pass_issuances, kilo_pass_subscriptions, kilocode_users } from '@kilocode/db/schema';
import {
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceSource,
  KiloPassAuditLogAction,
  type KiloPassTier,
} from '@/lib/kilo-pass/enums';
import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import { and, desc, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { KILO_PASS_TIER_CONFIG } from '@/lib/kilo-pass/constants';
import {
  appendKiloPassAuditLog,
  computeIssueMonth,
  createOrGetIssuanceHeader,
  issueBaseCreditsForIssuance,
} from '@/lib/kilo-pass/issuance';
import { toMicrodollars } from '@/lib/utils';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type Db = typeof defaultDb;

/**
 * Maximum number of catch-up steps per subscription per cron run.
 * 12 months = 1 year of catch-up per run.
 */
export const MAX_CATCHUP_STEPS_PER_SUBSCRIPTION = 12;

export type RunYearlyMonthlyBaseCronResult = {
  ran: boolean;
  nowIso: string;
  runId: string;
  dueSubscriptionCount: number;
  processedSubscriptionCount: number;
  catchupStepCount: number;
  baseIssuedCount: number;
  baseSkippedIdempotentCount: number;
  nextYearlyIssueAtAdvancedCount: number;
};

type DueSubscription = {
  subscriptionId: string;
  kiloUserId: string;
  stripeSubscriptionId: string;
  tier: KiloPassTier;
  nextYearlyIssueAt: string | null;
};

async function issueYearlyCadenceMonthlyBaseOnce(
  tx: DrizzleTransaction,
  params: {
    subscriptionId: string;
    kiloUserId: string;
    tier: KiloPassTier;
    nextYearlyIssueAt: string;
  }
): Promise<{
  issueMonth: string;
  nextYearlyIssueAtNewIso: string;
  issuanceId: string | null;
  issuanceHeaderWasCreated: boolean;
  baseWasIssued: boolean;
  baseCreditTransactionId: string | null;
}> {
  const { subscriptionId, kiloUserId, tier, nextYearlyIssueAt } = params;

  const issueMonth = computeIssueMonth(dayjs(nextYearlyIssueAt).utc());
  const nextYearlyIssueAtNewIso = dayjs(nextYearlyIssueAt).utc().add(1, 'month').toISOString();

  // Count total issuances since the last invoice-sourced issuance (start of yearly period)
  const lastInvoiceIssuance = await tx
    .select({ issueMonth: kilo_pass_issuances.issue_month })
    .from(kilo_pass_issuances)
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
        eq(kilo_pass_issuances.source, KiloPassIssuanceSource.StripeInvoice)
      )
    )
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const periodStartMonth = lastInvoiceIssuance[0]?.issueMonth;
  if (periodStartMonth) {
    const totalIssuances = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(kilo_pass_issuances)
      .where(
        and(
          eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
          sql`${kilo_pass_issuances.issue_month} >= ${periodStartMonth}`
        )
      );

    const count = totalIssuances[0]?.count ?? 0;
    if (count >= 12) {
      // All 12 months issued for this yearly period — skip but still advance cursor
      return {
        issueMonth,
        nextYearlyIssueAtNewIso: dayjs(nextYearlyIssueAt).utc().add(1, 'month').toISOString(),
        issuanceId: null,
        issuanceHeaderWasCreated: false,
        baseWasIssued: false,
        baseCreditTransactionId: null,
      };
    }
  }

  const issuanceHeader = await createOrGetIssuanceHeader(tx, {
    subscriptionId,
    issueMonth,
    source: KiloPassIssuanceSource.Cron,
    stripeInvoiceId: null,
  });

  const tierConfig = KILO_PASS_TIER_CONFIG[tier];
  const baseAmountUsd = tierConfig.monthlyPriceUsd;

  // `issueBaseCreditsForIssuance()` uses this as the Stripe-payment idempotency key.
  // For yearly cadence monthly base issuance, we generate a stable per-(subscription, month) key.
  const syntheticStripeInvoiceId = `kilo-pass-yearly-base:${subscriptionId}:${issueMonth}`;

  const baseResult = await issueBaseCreditsForIssuance(tx, {
    issuanceId: issuanceHeader.issuanceId,
    subscriptionId,
    kiloUserId,
    amountUsd: baseAmountUsd,
    stripeInvoiceId: syntheticStripeInvoiceId,
    description: `Kilo Pass base credits (${tier}, yearly, ${issueMonth})`,
  });

  if (baseResult.wasIssued) {
    await tx
      .update(kilocode_users)
      .set({
        kilo_pass_threshold: sql`${kilocode_users.microdollars_used} + ${toMicrodollars(baseAmountUsd)}`,
      })
      .where(eq(kilocode_users.id, kiloUserId));
  }

  // Use GREATEST() to ensure monotonic advancement - prevents regression under overlapping runs.
  await tx
    .update(kilo_pass_subscriptions)
    .set({
      next_yearly_issue_at: sql`GREATEST(${kilo_pass_subscriptions.next_yearly_issue_at}, ${nextYearlyIssueAtNewIso})`,
    })
    .where(eq(kilo_pass_subscriptions.id, subscriptionId));

  return {
    issueMonth,
    nextYearlyIssueAtNewIso,
    issuanceId: issuanceHeader.issuanceId,
    issuanceHeaderWasCreated: issuanceHeader.wasCreated,
    baseWasIssued: baseResult.wasIssued,
    baseCreditTransactionId: baseResult.creditTransactionId,
  };
}

export async function runKiloPassYearlyMonthlyBaseCron(
  db: Db,
  params?: {
    now?: Date;
  }
): Promise<RunYearlyMonthlyBaseCronResult> {
  const now = params?.now ? dayjs(params.now) : dayjs();
  const nowIso = now.utc().toISOString();
  const runId = crypto.randomUUID();

  await appendKiloPassAuditLog(db, {
    // Reuse the existing audit-log action value to satisfy the DB check constraint.
    // We disambiguate via `payload.kind`.
    action: KiloPassAuditLogAction.YearlyMonthlyBaseCronStarted,
    result: KiloPassAuditLogResult.Success,
    payload: { scope: 'run', kind: 'yearly_monthly_base', runId, nowIso },
  });

  const dueSubscriptions: DueSubscription[] = await db
    .select({
      subscriptionId: kilo_pass_subscriptions.id,
      kiloUserId: kilo_pass_subscriptions.kilo_user_id,
      stripeSubscriptionId: kilo_pass_subscriptions.stripe_subscription_id,
      tier: kilo_pass_subscriptions.tier,
      nextYearlyIssueAt: kilo_pass_subscriptions.next_yearly_issue_at,
    })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.cadence, KiloPassCadence.Yearly),
        inArray(kilo_pass_subscriptions.status, ['active', 'paused']),
        isNotNull(kilo_pass_subscriptions.next_yearly_issue_at),
        lte(kilo_pass_subscriptions.next_yearly_issue_at, nowIso)
      )
    )
    .orderBy(desc(kilo_pass_subscriptions.next_yearly_issue_at));

  let processedSubscriptionCount = 0;
  let catchupStepCount = 0;
  let baseIssuedCount = 0;
  let baseSkippedIdempotentCount = 0;
  let nextYearlyIssueAtAdvancedCount = 0;

  for (const subscription of dueSubscriptions) {
    const nextYearlyIssueAt = subscription.nextYearlyIssueAt;
    if (!nextYearlyIssueAt) {
      // Should be impossible due to the `isNotNull()` filter.
      continue;
    }

    const issueMonth = computeIssueMonth(dayjs(nextYearlyIssueAt).utc());

    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.YearlyMonthlyBaseCronStarted,
      result: KiloPassAuditLogResult.Success,
      kiloUserId: subscription.kiloUserId,
      kiloPassSubscriptionId: subscription.subscriptionId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      payload: {
        scope: 'subscription',
        kind: 'yearly_monthly_base',
        runId,
        issueMonth,
        nextYearlyIssueAt,
      },
    });

    let subscriptionSteps: Awaited<ReturnType<typeof issueYearlyCadenceMonthlyBaseOnce>>[] = [];
    let failedDueAt: string | null = null;

    try {
      subscriptionSteps = await db.transaction(async tx => {
        const steps: Awaited<ReturnType<typeof issueYearlyCadenceMonthlyBaseOnce>>[] = [];
        let stepsForSubscription = 0;
        let dueAt = nextYearlyIssueAt;

        while (dueAt <= nowIso && stepsForSubscription < MAX_CATCHUP_STEPS_PER_SUBSCRIPTION) {
          failedDueAt = dueAt;

          const step = await issueYearlyCadenceMonthlyBaseOnce(tx, {
            subscriptionId: subscription.subscriptionId,
            kiloUserId: subscription.kiloUserId,
            tier: subscription.tier,
            nextYearlyIssueAt: dueAt,
          });

          steps.push(step);
          stepsForSubscription += 1;
          dueAt = step.nextYearlyIssueAtNewIso;
        }

        return steps;
      });
    } catch (error) {
      await appendKiloPassAuditLog(db, {
        action: KiloPassAuditLogAction.BaseCreditsIssued,
        result: KiloPassAuditLogResult.Failed,
        kiloUserId: subscription.kiloUserId,
        kiloPassSubscriptionId: subscription.subscriptionId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        payload: {
          kind: 'yearly_monthly_base',
          runId,
          nextYearlyIssueAt: failedDueAt ?? nextYearlyIssueAt,
          tier: subscription.tier,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    if (subscriptionSteps.length > 0) {
      catchupStepCount += subscriptionSteps.length;
      nextYearlyIssueAtAdvancedCount += subscriptionSteps.length;

      for (const step of subscriptionSteps) {
        if (step.baseWasIssued) baseIssuedCount += 1;
        else baseSkippedIdempotentCount += 1;

        await appendKiloPassAuditLog(db, {
          action: KiloPassAuditLogAction.YearlyMonthlyBaseCronCompleted,
          result: KiloPassAuditLogResult.Success,
          kiloUserId: subscription.kiloUserId,
          kiloPassSubscriptionId: subscription.subscriptionId,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          relatedMonthlyIssuanceId: step.issuanceId,
          relatedCreditTransactionId: step.baseCreditTransactionId,
          payload: {
            scope: 'subscription',
            kind: 'yearly_monthly_base',
            runId,
            issueMonth: step.issueMonth,
            issuanceHeaderWasCreated: step.issuanceHeaderWasCreated,
            baseWasIssued: step.baseWasIssued,
            nextYearlyIssueAtAdvancedTo: step.nextYearlyIssueAtNewIso,
          },
        });
      }

      await forceImmediateExpirationRecomputation(subscription.kiloUserId);
      processedSubscriptionCount += 1;
    }
  }

  await appendKiloPassAuditLog(db, {
    action: KiloPassAuditLogAction.YearlyMonthlyBaseCronCompleted,
    result: KiloPassAuditLogResult.Success,
    payload: {
      scope: 'run',
      kind: 'yearly_monthly_base',
      runId,
      nowIso,
      dueSubscriptionCount: dueSubscriptions.length,
      processedSubscriptionCount,
      catchupStepCount,
      baseIssuedCount,
      baseSkippedIdempotentCount,
      nextYearlyIssueAtAdvancedCount,
    },
  });

  return {
    ran: true,
    nowIso,
    runId,
    dueSubscriptionCount: dueSubscriptions.length,
    processedSubscriptionCount,
    catchupStepCount,
    baseIssuedCount,
    baseSkippedIdempotentCount,
    nextYearlyIssueAtAdvancedCount,
  };
}
