import 'server-only';

import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { addMonths, format } from 'date-fns';

import { db } from '@/lib/drizzle';
import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  getKiloClawPlanCostMicrodollars,
  getKiloClawPricingCatalogEntry,
  insertKiloClawSubscriptionChangeLog,
  type KiloClawPriceVersion,
  type KiloClawSubscriptionChangeAction,
  type KiloClawSubscriptionChangeActor,
} from '@kilocode/db';
import {
  credit_transactions,
  kilocode_users,
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { captureException } from '@sentry/nextjs';
import { processTopUp } from '@/lib/credits';
import { sendKiloClawSubscriptionStartedEmail } from '@/lib/email';
import {
  autoResumeIfSuspended,
  clearTrialInactivityStopAfterTrialTransition,
} from '@/lib/kiloclaw/instance-lifecycle';
import {
  buildAffiliateEventDedupeKey,
  enqueueAffiliateEventForUser,
} from '@/lib/impact/affiliate-events';
import { processPersonalKiloClawPaidConversion } from '@/lib/impact/kiloclaw-referrals';
import { ImpactReferralPaymentProvider } from '@kilocode/db/schema-types';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { getKiloPassStateForUser, type KiloPassSubscriptionState } from '@/lib/kilo-pass/state';
import {
  computeProjectedKiloPassBonusMicrodollars,
  getEffectiveKiloPassThreshold,
} from '@kilocode/worker-utils/kilo-pass-bonus-projection';
import { sentryLogger } from '@/lib/utils.server';
import { IMPACT_ORDER_ID_MACRO } from '@/lib/impact';
import {
  getStripePriceIdForClawPlan,
  getStripePriceIdForClawPlanIntro,
} from '@/lib/kiloclaw/stripe-price-ids.server';
import {
  CurrentPersonalSubscriptionResolutionError,
  resolveCurrentPersonalSubscriptionRow,
} from '@/lib/kiloclaw/current-personal-subscription';

const logInfo = sentryLogger('kiloclaw-credit-billing', 'info');
const logWarning = sentryLogger('kiloclaw-credit-billing', 'warning');
const logError = sentryLogger('kiloclaw-credit-billing', 'error');
const CREDIT_BILLING_ACTOR = {
  actorType: 'system',
  actorId: 'kiloclaw-credit-billing',
} as const;
const PAID_ACTIVATION_LIFECYCLE_CLEAR_SET = {
  suspended_at: null,
  destruction_deadline: null,
  auto_resume_requested_at: null,
  auto_resume_retry_after: null,
  auto_resume_attempt_count: 0,
} as const;
const PAID_AUTO_RESUME_INITIAL_STATE = {
  auto_resume_requested_at: null,
  auto_resume_retry_after: null,
  auto_resume_attempt_count: 0,
} as const;

type CreditSettlementPersonalRow = {
  subscription: typeof kiloclaw_subscriptions.$inferSelect;
  organizationId: string | null;
};

class CreditSettlementResolutionError extends Error {
  readonly reason: string;
  readonly details: Record<string, string | number | boolean | null | undefined>;

  constructor(
    reason: string,
    details: Record<string, string | number | boolean | null | undefined> = {}
  ) {
    super(reason);
    this.name = 'CreditSettlementResolutionError';
    this.reason = reason;
    this.details = details;
  }
}

type CreditBillingTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function selectCreditSettlementRowById(
  tx: CreditBillingTx,
  subscriptionId: string
): Promise<CreditSettlementPersonalRow | null> {
  const [row] = await tx
    .select({
      subscription: kiloclaw_subscriptions,
      organizationId: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(eq(kiloclaw_subscriptions.id, subscriptionId))
    .limit(1);

  return row ?? null;
}

async function selectCreditSettlementRowsByStripeId(
  tx: CreditBillingTx,
  stripeSubscriptionId: string
): Promise<CreditSettlementPersonalRow[]> {
  return await tx
    .select({
      subscription: kiloclaw_subscriptions,
      organizationId: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    .limit(2);
}

async function selectCreditSettlementRowByInstanceId(params: {
  tx: CreditBillingTx;
  userId: string;
  instanceId: string;
}): Promise<CreditSettlementPersonalRow | null> {
  const [row] = await params.tx
    .select({
      subscription: kiloclaw_subscriptions,
      organizationId: kiloclaw_instances.organization_id,
    })
    .from(kiloclaw_subscriptions)
    .innerJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.instance_id, params.instanceId),
        eq(kiloclaw_subscriptions.user_id, params.userId),
        eq(kiloclaw_instances.user_id, params.userId),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .limit(1);

  return row ?? null;
}

async function selectCurrentCreditSettlementRow(
  tx: CreditBillingTx,
  userId: string
): Promise<CreditSettlementPersonalRow | null> {
  try {
    const row = await resolveCurrentPersonalSubscriptionRow({ userId, dbOrTx: tx });
    if (!row) {
      return null;
    }
    return {
      subscription: row.subscription,
      organizationId: row.instance?.organizationId ?? null,
    };
  } catch (error) {
    if (error instanceof CurrentPersonalSubscriptionResolutionError) {
      throw new CreditSettlementResolutionError('multiple_current_rows', {
        user_id: userId,
        instance_id: error.instanceId,
      });
    }
    throw error;
  }
}

function assertCreditSettlementPersonalRow(
  row: CreditSettlementPersonalRow,
  userId: string
): CreditSettlementPersonalRow {
  if (row.subscription.user_id !== userId) {
    throw new CreditSettlementResolutionError('user_mismatch', {
      subscription_id: row.subscription.id,
      row_user_id: row.subscription.user_id,
      user_id: userId,
    });
  }

  if (row.organizationId !== null) {
    throw new CreditSettlementResolutionError('org_boundary', {
      subscription_id: row.subscription.id,
      organization_id: row.organizationId,
      user_id: userId,
    });
  }

  return row;
}

async function followTransferredCreditSettlementRow(params: {
  tx: CreditBillingTx;
  start: CreditSettlementPersonalRow;
  userId: string;
}): Promise<CreditSettlementPersonalRow> {
  let current = assertCreditSettlementPersonalRow(params.start, params.userId);
  const seen = new Set([current.subscription.id]);

  for (let hops = 0; hops < 8; hops += 1) {
    const nextId = current.subscription.transferred_to_subscription_id;
    if (!nextId) {
      return current;
    }

    const next = await selectCreditSettlementRowById(params.tx, nextId);
    if (!next) {
      throw new CreditSettlementResolutionError('missing_lineage_target', {
        subscription_id: current.subscription.id,
        transferred_to_subscription_id: nextId,
        user_id: params.userId,
      });
    }

    current = assertCreditSettlementPersonalRow(next, params.userId);
    if (seen.has(current.subscription.id)) {
      throw new CreditSettlementResolutionError('lineage_cycle', {
        subscription_id: current.subscription.id,
        user_id: params.userId,
      });
    }
    seen.add(current.subscription.id);
  }

  throw new CreditSettlementResolutionError('lineage_hop_limit', {
    subscription_id: params.start.subscription.id,
    user_id: params.userId,
  });
}

async function clearTransferredSettlementStripeOwnership(params: {
  tx: CreditBillingTx;
  row: CreditSettlementPersonalRow;
  reason: string;
}) {
  if (!params.row.subscription.transferred_to_subscription_id) {
    return;
  }

  const [after] = await params.tx
    .update(kiloclaw_subscriptions)
    .set({
      payment_source: 'credits',
      stripe_subscription_id: null,
      stripe_schedule_id: null,
      cancel_at_period_end: false,
      pending_conversion: false,
    })
    .where(eq(kiloclaw_subscriptions.id, params.row.subscription.id))
    .returning();

  await insertKiloClawSubscriptionChangeLog(params.tx, {
    subscriptionId: params.row.subscription.id,
    actor: CREDIT_BILLING_ACTOR,
    action: 'status_changed',
    reason: params.reason,
    before: params.row.subscription,
    after: after ?? null,
  });
}

function getKiloClawAffiliateItemCategory(params: {
  plan: 'commit' | 'standard';
  priceVersion: string;
}): string {
  return `kiloclaw-${params.plan}-${params.priceVersion}`;
}

function getKiloClawAffiliateItemName(plan: 'commit' | 'standard'): string {
  return plan === 'commit' ? 'KiloClaw Commit Plan' : 'KiloClaw Standard Plan';
}

async function enqueueCreditEnrollmentAffiliateEvents(params: {
  userId: string;
  plan: 'commit' | 'standard';
  saleEntityId: string;
  saleOrderId: string;
  saleAmountMicrodollars: number;
  eventDate: Date;
  saleItemSku: string;
  priceVersion: string;
  trialEndEntityId?: string;
}): Promise<void> {
  if (params.trialEndEntityId) {
    await enqueueAffiliateEventForUser({
      userId: params.userId,
      provider: 'impact',
      eventType: 'trial_end',
      dedupeKey: buildAffiliateEventDedupeKey({
        provider: 'impact',
        eventType: 'trial_end',
        entityId: params.trialEndEntityId,
      }),
      eventDate: params.eventDate,
      orderId: IMPACT_ORDER_ID_MACRO,
    });
  }

  const itemCategory = getKiloClawAffiliateItemCategory({
    plan: params.plan,
    priceVersion: params.priceVersion,
  });

  const conversionDisposition = await processPersonalKiloClawPaidConversion({
    userId: params.userId,
    sourcePaymentId: params.saleOrderId,
    orderId: params.saleOrderId,
    paymentProvider: ImpactReferralPaymentProvider.Credits,
    amount: params.saleAmountMicrodollars / 1_000_000,
    currencyCode: 'usd',
    itemCategory,
    itemName: getKiloClawAffiliateItemName(params.plan),
    itemSku: params.saleItemSku,
    convertedAt: params.eventDate,
  });

  if (!conversionDisposition.shouldEnqueueAffiliateSale) {
    return;
  }

  await enqueueAffiliateEventForUser({
    userId: params.userId,
    provider: 'impact',
    eventType: 'sale',
    dedupeKey: buildAffiliateEventDedupeKey({
      provider: 'impact',
      eventType: 'sale',
      entityId: params.saleEntityId,
    }),
    eventDate: params.eventDate,
    orderId: params.saleOrderId,
    amount: params.saleAmountMicrodollars / 1_000_000,
    currencyCode: 'usd',
    itemCategory,
    itemName: getKiloClawAffiliateItemName(params.plan),
    itemSku: params.saleItemSku,
  });
}

/**
 * Project the pending Kilo Pass bonus microdollars that would be awarded
 * by the next call to maybeIssueKiloPassBonusFromUsageThreshold.
 *
 * Returns 0 when the user has no Kilo Pass, usage hasn't crossed the
 * threshold, or the subscription isn't active. This is a read-only
 * projection — no credits are issued.
 */
export async function projectPendingKiloPassBonusMicrodollars(params: {
  userId: string;
  microdollarsUsed: number;
  kiloPassThreshold: number | null;
  subscription?: KiloPassSubscriptionState | null;
}): Promise<number> {
  const {
    userId,
    microdollarsUsed,
    kiloPassThreshold,
    subscription: providedSubscription,
  } = params;

  const effectiveThreshold = getEffectiveKiloPassThreshold(kiloPassThreshold);
  if (effectiveThreshold === null || microdollarsUsed < effectiveThreshold) return 0;

  const subscription =
    providedSubscription !== undefined
      ? providedSubscription
      : await getKiloPassStateForUser(db, userId);

  return computeProjectedKiloPassBonusMicrodollars({
    microdollarsUsed,
    kiloPassThreshold,
    subscription: subscription
      ? {
          tier: subscription.tier,
          cadence: subscription.cadence,
          status: subscription.status,
          currentStreakMonths: subscription.currentStreakMonths,
        }
      : null,
  });
}

export async function getEffectiveCreditBalancePreview(params: {
  userId: string;
  balanceMicrodollars: number;
  microdollarsUsed: number;
  kiloPassThreshold: number | null;
  costMicrodollars: number;
  subscription?: KiloPassSubscriptionState | null;
}): Promise<{
  projectedKiloPassBonusMicrodollars: number;
  effectiveBalanceMicrodollars: number;
}> {
  const projectedKiloPassBonusMicrodollars = await projectPendingKiloPassBonusMicrodollars({
    userId: params.userId,
    microdollarsUsed: params.microdollarsUsed + params.costMicrodollars,
    kiloPassThreshold: params.kiloPassThreshold,
    subscription: params.subscription,
  });

  return {
    projectedKiloPassBonusMicrodollars,
    effectiveBalanceMicrodollars: params.balanceMicrodollars + projectedKiloPassBonusMicrodollars,
  };
}

/**
 * Settle a Stripe-funded KiloClaw invoice into the credit ledger.
 *
 * Creates a balance-neutral credit pair (positive deposit + matching negative deduction),
 * converts the subscription to hybrid state (payment_source='credits' with
 * stripe_subscription_id preserved), and advances the billing period from
 * invoice-derived boundaries.
 */
export async function applyStripeFundedKiloClawPeriod(params: {
  userId: string;
  metadataInstanceId?: string;
  stripeSubscriptionId: string;
  stripePaymentId: string;
  plan: 'commit' | 'standard';
  priceVersion: KiloClawPriceVersion;
  amountMicrodollars: number;
  periodStart: string;
  periodEnd: string;
}): Promise<boolean> {
  const {
    userId,
    metadataInstanceId,
    stripeSubscriptionId,
    stripePaymentId,
    plan,
    priceVersion,
    amountMicrodollars,
    periodStart,
    periodEnd,
  } = params;

  const amountCents = Math.round(amountMicrodollars / 10_000);
  const periodStartDate = periodStart.slice(0, 10); // YYYY-MM-DD

  let wasSuspended = false;
  let resolvedInstanceId: string | undefined;
  let resolvedSubscriptionId: string | undefined;
  let applied = false;
  // True when this settlement transitions the subscription into a paid active
  // period from a non-active state (trialing or canceled). Renewals
  // (before.status === 'active') and recovery states (past_due / unpaid) do
  // not send the "subscription started" email. See
  // shouldSendSubscriptionStartedEmailForActivation.
  let shouldSendSubscriptionStartedEmailForNewSettlement = false;
  // Set when the primary settlement insert was a duplicate (processTopUp
  // returned false). In that case the downstream email side effect may not
  // have run yet and we attempt best-effort recovery after commit.
  let settlementWasDuplicate = false;

  await db.transaction(async tx => {
    const user = await tx.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, userId),
    });

    if (!user) {
      logWarning('User not found for credit settlement', {
        user_id: userId,
        stripe_payment_id: stripePaymentId,
      });
      return;
    }

    const stripeRows = await selectCreditSettlementRowsByStripeId(tx, stripeSubscriptionId);
    if (stripeRows.length > 1) {
      logWarning('Stripe-funded settlement quarantined: duplicate stripe subscription id', {
        user_id: userId,
        stripe_subscription_id: stripeSubscriptionId,
      });
      return;
    }

    const stripeOwnerRow = stripeRows[0] ?? null;
    let resolvedTarget: CreditSettlementPersonalRow | null = null;

    try {
      if (stripeOwnerRow) {
        resolvedTarget = await followTransferredCreditSettlementRow({
          tx,
          start: stripeOwnerRow,
          userId,
        });
      } else if (metadataInstanceId) {
        const metadataRow = await selectCreditSettlementRowByInstanceId({
          tx,
          userId,
          instanceId: metadataInstanceId,
        });
        if (metadataRow) {
          resolvedTarget = await followTransferredCreditSettlementRow({
            tx,
            start: metadataRow,
            userId,
          });
        }
      } else {
        const currentRow = await selectCurrentCreditSettlementRow(tx, userId);
        if (currentRow) {
          resolvedTarget = await followTransferredCreditSettlementRow({
            tx,
            start: currentRow,
            userId,
          });
        }
      }
    } catch (error) {
      if (error instanceof CreditSettlementResolutionError) {
        logWarning('Stripe-funded settlement quarantined: lineage resolution failed', {
          user_id: userId,
          stripe_subscription_id: stripeSubscriptionId,
          metadata_instance_id: metadataInstanceId ?? null,
          reason: error.reason,
          ...error.details,
        });
        return;
      }
      throw error;
    }

    if (!resolvedTarget || !resolvedTarget.subscription.instance_id) {
      logWarning('Stripe-funded settlement quarantined: missing personal instance target', {
        user_id: userId,
        stripe_subscription_id: stripeSubscriptionId,
        metadata_instance_id: metadataInstanceId ?? null,
      });
      return;
    }

    if (stripeOwnerRow && stripeOwnerRow.subscription.id !== resolvedTarget.subscription.id) {
      await clearTransferredSettlementStripeOwnership({
        tx,
        row: stripeOwnerRow,
        reason: 'stripe_invoice_settlement_reconciled_to_successor',
      });
    }

    const targetRow = resolvedTarget.subscription;
    if (targetRow.kiloclaw_price_version !== priceVersion) {
      logWarning('Stripe-funded settlement quarantined: invoice price version mismatch', {
        user_id: userId,
        stripe_subscription_id: stripeSubscriptionId,
        subscription_id: targetRow.id,
        row_price_version: targetRow.kiloclaw_price_version,
        invoice_price_version: priceVersion,
      });
      return;
    }

    wasSuspended = !!targetRow.suspended_at;
    resolvedInstanceId = targetRow.instance_id ?? undefined;
    resolvedSubscriptionId = targetRow.id;

    const shouldClearSchedule = targetRow.scheduled_plan === plan;
    if (targetRow.plan !== plan && !shouldClearSchedule) {
      logWarning('Stripe-funded settlement invoice plan differs from local subscription plan', {
        user_id: userId,
        stripe_subscription_id: stripeSubscriptionId,
        subscription_id: targetRow.id,
        row_plan: targetRow.plan,
        invoice_plan: plan,
      });
    }
    const commitEndsAt = plan === 'commit' ? periodEnd : null;

    const deposited = await processTopUp(
      user,
      amountCents,
      { type: 'stripe', stripe_payment_id: stripePaymentId },
      {
        skipPostTopUpFreeStuff: true,
        dbOrTx: tx,
        creditDescription: `KiloClaw ${plan} settlement`,
      }
    );

    if (!deposited) {
      logInfo('Duplicate settlement credit skipped', {
        user_id: userId,
        stripe_payment_id: stripePaymentId,
      });
      applied = true;
      settlementWasDuplicate = true;
      return;
    }

    const deductionCategory = `kiloclaw-settlement:${stripeSubscriptionId}:${periodStartDate}`;
    const deductionResult = await tx
      .insert(credit_transactions)
      .values({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        amount_microdollars: -amountMicrodollars,
        is_free: false,
        description: `KiloClaw ${plan} period deduction`,
        credit_category: deductionCategory,
        check_category_uniqueness: true,
        original_baseline_microdollars_used: user.microdollars_used,
      })
      .onConflictDoNothing();

    if ((deductionResult.rowCount ?? 0) > 0) {
      await tx
        .update(kilocode_users)
        .set({
          total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${amountMicrodollars}`,
        })
        .where(eq(kilocode_users.id, userId));
    } else {
      logInfo('Duplicate deduction skipped, proceeding with subscription update', {
        user_id: userId,
        deductionCategory,
      });
    }

    const updateSet = {
      instance_id: targetRow.instance_id,
      stripe_subscription_id: stripeSubscriptionId,
      payment_source: 'credits' as const,
      status: 'active' as const,
      plan,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      credit_renewal_at: periodEnd,
      commit_ends_at: commitEndsAt,
      past_due_since: null,
      auto_top_up_triggered_for_period: null,
      ...PAID_ACTIVATION_LIFECYCLE_CLEAR_SET,
      ...(wasSuspended ? PAID_AUTO_RESUME_INITIAL_STATE : {}),
      ...(shouldClearSchedule
        ? { scheduled_plan: null, scheduled_by: null, stripe_schedule_id: null }
        : {}),
    };

    const [before] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, targetRow.id))
      .limit(1);

    shouldSendSubscriptionStartedEmailForNewSettlement =
      shouldSendSubscriptionStartedEmailForActivation(before?.status ?? null) ||
      (await didStripeSubscriptionCreatedRecordEligibleActivation({
        tx,
        subscriptionId: targetRow.id,
        plan,
        periodStart,
        periodEnd,
      }));
    const [after] = await tx
      .update(kiloclaw_subscriptions)
      .set(updateSet)
      .where(eq(kiloclaw_subscriptions.id, targetRow.id))
      .returning();
    if (before && after) {
      await insertKiloClawSubscriptionChangeLog(tx, {
        subscriptionId: after.id,
        actor: CREDIT_BILLING_ACTOR,
        action: 'period_advanced',
        reason: 'stripe_invoice_settlement',
        before,
        after,
      });
    }

    applied = true;
  });

  if (!applied) {
    return false;
  }

  if (wasSuspended) {
    await autoResumeIfSuspended(userId, resolvedInstanceId);
  }

  // Best-effort Kilo Pass bonus evaluation.
  try {
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: userId,
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    logError('Kilo Pass bonus evaluation failed after settlement', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Steady-state webhook replays against an already-emailed, already-settled
  // period hit the duplicate-settlement branch on every retry. The real
  // idempotency guard is the `kiloclaw_email_log` unique index inside
  // `maybeSendKiloClawSubscriptionStartedEmail`, but we can skip the more
  // expensive `kiloclaw_subscription_change_log` scan (and the subsequent
  // no-op send call) when a matching email-log row already exists.
  const shouldSendSubscriptionStartedEmail =
    shouldSendSubscriptionStartedEmailForNewSettlement ||
    (settlementWasDuplicate &&
      resolvedSubscriptionId !== undefined &&
      resolvedInstanceId !== undefined &&
      !(await subscriptionStartedEmailAlreadyLoggedForActivation({
        userId,
        instanceId: resolvedInstanceId,
        periodStart,
      })) &&
      (await didPriorSettlementRecordPaidActivation({
        subscriptionId: resolvedSubscriptionId,
        plan,
        periodStart,
        periodEnd,
      })));

  // Per KiloClaw billing spec (Stripe-Funded Credit Settlement rule 10),
  // $0 KiloClaw invoices must still run settlement and transition the row
  // into the activated hybrid state. The subscription-started email is an
  // activation notification, not a revenue side effect, so it must fire
  // regardless of invoice amount. Revenue side effects (analytics,
  // affiliate sale events) apply their own `amount_paid > 0` guard in
  // stripe-handlers.ts.
  if (resolvedInstanceId && shouldSendSubscriptionStartedEmail) {
    await maybeSendKiloClawSubscriptionStartedEmail({
      userId,
      instanceId: resolvedInstanceId,
      plan,
      amountCents: Math.round(amountMicrodollars / 10_000),
      periodStart,
      periodEnd,
    });
  }

  logInfo('Credit settlement completed', {
    user_id: userId,
    plan,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_payment_id: stripePaymentId,
    amountMicrodollars,
  });

  return true;
}

export const KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE = 'kiloclaw_subscription_started';

/**
 * A settlement activates a paid period (and may produce a "subscription
 * started" email) only when the subscription was NOT already active before
 * settlement. Recovery/dunning states (past_due, unpaid) are excluded; those
 * flows are payment-recovery on an active plan, not a new activation.
 * Eligible: trialing, canceled (including canceled paid rows that resubscribe).
 * @param beforeStatus — the previous subscription status
 * @returns whether to send the "subscription started" email
 */
export function shouldSendSubscriptionStartedEmailForActivation(
  beforeStatus: string | null
): boolean {
  return beforeStatus === 'trialing' || beforeStatus === 'canceled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringFieldOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Compare two timestamp strings by parsing them as Dates. Handles the case
 * where a JSONB-serialized timestamp uses Postgres text form
 * ("2026-05-04 16:52:41.287+00") while the input is ISO-8601
 * ("2026-05-04T16:52:41.287Z"). Returns false for either side unparseable.
 *
 * @param a First timestamp string to compare.
 * @param b Second timestamp string to compare.
 * @returns Whether both timestamps parse to the same millisecond value.
 */
function timestampsEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const aMs = new Date(a).getTime();
  const bMs = new Date(b).getTime();
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  return aMs === bMs;
}

/**
 * Best-effort check: does `kiloclaw_subscription_change_log` contain a prior
 * `period_advanced` / `stripe_invoice_settlement` entry that transitioned the
 * given subscription into a paid active period for the exact plan and
 * period? Used to recover the subscription-started email when a replay of
 * settlement hits the duplicate-credit path and the original in-transaction
 * email send may have failed. Returns false on missing/malformed rows; the
 * `kiloclaw_email_log` unique index remains the final idempotency guard.
 *
 * Identity is established by subscription_id + action/reason scope + exact
 * plan/period-boundary match on `after_state`. `stripe_invoice_settlement`
 * rows are written only by `applyStripeFundedKiloClawPeriod` (once per
 * successful settlement), and KiloClaw never uses Stripe proration, so
 * renewals move period boundaries forward and two settlements on the same
 * subscription cannot share plan+period. No time-window guard is needed: a
 * legitimately delayed webhook replay (e.g., manual Stripe-dashboard
 * resend well after the period started) should still recover the email.
 *
 * @param params Subscription and settlement period identity to match.
 * @returns Whether a prior settlement recorded an eligible paid activation.
 */
async function didPriorSettlementRecordPaidActivation(params: {
  subscriptionId: string;
  plan: 'commit' | 'standard';
  periodStart: string;
  periodEnd: string;
}): Promise<boolean> {
  const { subscriptionId, plan, periodStart, periodEnd } = params;

  const rows = await db
    .select({
      before_state: kiloclaw_subscription_change_log.before_state,
      after_state: kiloclaw_subscription_change_log.after_state,
    })
    .from(kiloclaw_subscription_change_log)
    .where(
      and(
        eq(kiloclaw_subscription_change_log.subscription_id, subscriptionId),
        eq(kiloclaw_subscription_change_log.action, 'period_advanced'),
        eq(kiloclaw_subscription_change_log.reason, 'stripe_invoice_settlement')
      )
    )
    .orderBy(desc(kiloclaw_subscription_change_log.created_at))
    .limit(10);

  for (const row of rows) {
    if (!isRecord(row.before_state) || !isRecord(row.after_state)) continue;

    const beforeStatus = stringFieldOrNull(row.before_state, 'status');
    if (!shouldSendSubscriptionStartedEmailForActivation(beforeStatus)) continue;

    const afterStatus = stringFieldOrNull(row.after_state, 'status');
    const afterPlan = stringFieldOrNull(row.after_state, 'plan');
    const afterPeriodStart = stringFieldOrNull(row.after_state, 'current_period_start');
    const afterPeriodEnd = stringFieldOrNull(row.after_state, 'current_period_end');
    if (
      afterStatus !== 'active' ||
      afterPlan !== plan ||
      !timestampsEqual(afterPeriodStart, periodStart) ||
      !timestampsEqual(afterPeriodEnd, periodEnd)
    ) {
      continue;
    }

    return true;
  }

  return false;
}

/**
 * Durable pre-settlement activation signal.
 *
 * `handleKiloClawSubscriptionCreated` can run before `invoice.paid` and will
 * transition a non-hybrid row to status='active', masking the pre-Stripe
 * status from the in-transaction snapshot used to decide whether this
 * settlement is a first paid activation. The handler writes a
 * `stripe_subscription_created` change-log row that preserves
 * `before_state.status` and records the Stripe-derived plan/period in
 * `after_state`, which is the durable evidence we need.
 *
 * Returns true when a `stripe_subscription_created` entry for this
 * subscription has:
 * - `before_state.status` that `shouldSendSubscriptionStartedEmailForActivation`
 *   accepts (trialing or canceled), AND
 * - `after_state.plan` / `after_state.current_period_start` /
 *   `after_state.current_period_end` matching the current settlement.
 *
 * Matching on identity (plan + period boundaries) instead of audit-log
 * ordering avoids relying on `created_at`, which is `now()` and therefore
 * transaction-start scoped rather than a reliable commit/insert chronology
 * under concurrent webhook transactions. A later renewal settlement has a
 * different period than the original activation, so an old
 * `stripe_subscription_created` row from the initial activation cannot match
 * and cannot re-fire the email. The `kiloclaw_email_log` unique index
 * remains the final idempotency guard.
 *
 * @param params Transaction, subscription, and settlement period identity to match.
 * @returns Whether subscription-created handling recorded an eligible activation.
 */
async function didStripeSubscriptionCreatedRecordEligibleActivation(params: {
  tx: CreditBillingTx;
  subscriptionId: string;
  plan: 'commit' | 'standard';
  periodStart: string;
  periodEnd: string;
}): Promise<boolean> {
  const { tx, subscriptionId, plan, periodStart, periodEnd } = params;
  const rows = await tx
    .select({
      before_state: kiloclaw_subscription_change_log.before_state,
      after_state: kiloclaw_subscription_change_log.after_state,
    })
    .from(kiloclaw_subscription_change_log)
    .where(
      and(
        eq(kiloclaw_subscription_change_log.subscription_id, subscriptionId),
        eq(kiloclaw_subscription_change_log.reason, 'stripe_subscription_created')
      )
    )
    .orderBy(desc(kiloclaw_subscription_change_log.created_at))
    .limit(20);

  for (const row of rows) {
    if (!isRecord(row.before_state) || !isRecord(row.after_state)) continue;
    const beforeStatus = stringFieldOrNull(row.before_state, 'status');
    if (!shouldSendSubscriptionStartedEmailForActivation(beforeStatus)) continue;
    const afterPlan = stringFieldOrNull(row.after_state, 'plan');
    const afterPeriodStart = stringFieldOrNull(row.after_state, 'current_period_start');
    const afterPeriodEnd = stringFieldOrNull(row.after_state, 'current_period_end');
    if (
      afterPlan === plan &&
      timestampsEqual(afterPeriodStart, periodStart) &&
      timestampsEqual(afterPeriodEnd, periodEnd)
    ) {
      return true;
    }
  }

  return false;
}

function formatBillingPeriod(periodStart: string, periodEnd: string): string {
  const start = format(new Date(periodStart), 'MMM d, yyyy');
  const end = format(new Date(periodEnd), 'MMM d, yyyy');
  return `${start} – ${end}`;
}

function planDisplayName(plan: 'commit' | 'standard'): string {
  return plan === 'commit' ? 'KiloClaw Commit' : 'KiloClaw Standard';
}

/**
 * Best-effort at-most-once dedupe via insert-before-send on
 * `kiloclaw_email_log`, guarded by the unique index
 * (user_id, instance_id, email_type, period_start). Each activation event
 * (fresh `periodStart`) gets exactly one row; webhook replays of the same
 * event collide on the index and return early. Because the
 * KiloClaw subscription row is reused across cancel+resubscribe (both
 * Stripe and credit paths UPDATE in place), period_start is what actually
 * distinguishes a resubscribe's activation from the original, hence one
 * email per activation, not one per instance lifetime.
 *
 * Known gaps shared with every other insert-before-send email path in this
 * codebase (`maybeSendTopUpConfirmationEmail` in `apps/web/src/lib/credits.ts`,
 * `services/kiloclaw-billing/src/lifecycle.ts` ~L850, and the
 * `kiloclaw_email_log`-gated sends in `apps/web/src/app/api/internal/kiloclaw/`):
 * 1. A crash between the marker insert and the provider send permanently
 *    suppresses the email on retry; the marker looks "already sent".
 * 2. Rolling the marker back in the catch block after an ambiguous provider
 *    exception can duplicate the email if the provider actually accepted it.
 *
 * Fixing either properly requires a real outbox (pending/sent/terminal state
 * + provider idempotency keys) applied uniformly across all of the above
 * call sites. Tracked as follow-up tech debt; intentionally NOT fixed in
 * isolation here so this new email path stays uniform with the existing ones.
 *
 * @param params User, instance, plan, price, and period details for the activation email.
 * @returns A promise that resolves after the idempotency check and best-effort send attempt.
 */
async function maybeSendKiloClawSubscriptionStartedEmail(params: {
  userId: string;
  instanceId: string;
  plan: 'commit' | 'standard';
  amountCents: number;
  periodStart: string;
  periodEnd: string;
}): Promise<void> {
  const { userId, instanceId, plan, amountCents, periodStart, periodEnd } = params;
  try {
    // Look up the user BEFORE inserting the marker. Inserting first and
    // then discovering a missing user would leak the marker and permanently
    // suppress the email on retry. Mirrors
    // apps/web/src/app/api/internal/kiloclaw/instance-ready/route.ts:100-151.
    const [user] = await db
      .select({ email: kilocode_users.google_user_email })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId))
      .limit(1);

    if (!user) {
      logWarning('KiloClaw subscription-started email: user not found', {
        user_id: userId,
        instance_id: instanceId,
      });
      return;
    }

    const insertResult = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: userId,
        instance_id: instanceId,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
        period_start: periodStart,
      })
      .onConflictDoNothing();

    if ((insertResult.rowCount ?? 0) === 0) {
      // This activation was already processed — webhook replay, nothing to send.
      return;
    }

    const sendResult = await sendKiloClawSubscriptionStartedEmail({
      to: user.email,
      planName: planDisplayName(plan),
      priceCents: amountCents,
      billingPeriod: formatBillingPeriod(periodStart, periodEnd),
      nextBillingDate: new Date(periodEnd),
    });

    // If the provider is not configured (e.g. Mailgun env missing in a test or
    // preview environment), the send never reached a real provider and a later
    // webhook retry should be free to re-attempt. Clear the marker we just
    // inserted so the unique-index guard does not permanently suppress the
    // email. Mirrors services/kiloclaw-billing/src/lifecycle.ts:879-884.
    //
    // `neverbounce_rejected` is deliberately NOT cleared: NeverBounce's verdict
    // is terminal for that address (invalid / disposable), so retrying would
    // loop forever. Leaving the row keeps the behavior idempotent — we tried
    // once, the address was rejected, we don't try again.
    if (!sendResult.sent && sendResult.reason === 'provider_not_configured') {
      await deleteSubscriptionStartedEmailLog({ userId, instanceId, periodStart });
    }
  } catch (error) {
    // Never fail the settlement flow because of an email error.
    captureException(error, {
      tags: { source: 'kiloclaw_subscription_started_email' },
      extra: { user_id: userId, instance_id: instanceId, plan },
    });
    // Best-effort rollback so a retry can re-attempt — mirrors the pattern in
    // apps/web/src/app/api/internal/kiloclaw/instance-ready/route.ts. Scope
    // the delete to this activation's period so we only clear the marker we
    // just inserted.
    try {
      await deleteSubscriptionStartedEmailLog({ userId, instanceId, periodStart });
    } catch {
      // Leave the marker in place; we prefer missing one email over duplicate sends.
    }
  }
}

async function deleteSubscriptionStartedEmailLog(params: {
  userId: string;
  instanceId: string;
  periodStart: string;
}): Promise<void> {
  const { userId, instanceId, periodStart } = params;
  await db
    .delete(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, userId),
        eq(kiloclaw_email_log.instance_id, instanceId),
        eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE),
        eq(kiloclaw_email_log.period_start, periodStart)
      )
    );
}

/**
 * Fast-path existence check covered by the
 * `UQ_kiloclaw_email_log_user_instance_type_period` unique index. Used to
 * short-circuit the duplicate-settlement activation recovery path before
 * running the more expensive `kiloclaw_subscription_change_log` scan.
 *
 * @param params User, instance, and activation period to check.
 * @returns Whether this activation already has an email-log marker.
 */
async function subscriptionStartedEmailAlreadyLoggedForActivation(params: {
  userId: string;
  instanceId: string;
  periodStart: string;
}): Promise<boolean> {
  const { userId, instanceId, periodStart } = params;
  const [existing] = await db
    .select({ id: kiloclaw_email_log.id })
    .from(kiloclaw_email_log)
    .where(
      and(
        eq(kiloclaw_email_log.user_id, userId),
        eq(kiloclaw_email_log.instance_id, instanceId),
        eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE),
        eq(kiloclaw_email_log.period_start, periodStart)
      )
    )
    .limit(1);
  return existing !== undefined;
}

/**
 * Enroll a user's instance in a KiloClaw hosting plan funded by credits.
 *
 * Deducts the first period's cost from the user's credit balance and creates
 * (or upserts) an active pure-credit subscription. See spec "Credit Enrollment"
 * rules 1-8.
 */
export async function enrollWithCredits(params: {
  userId: string;
  instanceId: string;
  plan: 'commit' | 'standard';
  hadPaidSubscription: boolean;
  actor?: KiloClawSubscriptionChangeActor;
}): Promise<void> {
  const { userId, instanceId, plan, hadPaidSubscription } = params;

  // Step 1: Read current state
  const [user] = await db
    .select({
      total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
      microdollars_used: kilocode_users.microdollars_used,
      kilo_pass_threshold: kilocode_users.kilo_pass_threshold,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) {
    logError('Credit enrollment failed: user not found', { user_id: userId, instanceId });
    throw new Error('User not found');
  }

  const [existingSub] = await db
    .select({
      id: kiloclaw_subscriptions.id,
      plan: kiloclaw_subscriptions.plan,
      status: kiloclaw_subscriptions.status,
      suspended_at: kiloclaw_subscriptions.suspended_at,
      kiloclaw_price_version: kiloclaw_subscriptions.kiloclaw_price_version,
    })
    .from(kiloclaw_subscriptions)
    .leftJoin(kiloclaw_instances, eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id))
    .where(
      and(
        eq(kiloclaw_subscriptions.user_id, userId),
        eq(kiloclaw_subscriptions.instance_id, instanceId),
        isNull(kiloclaw_subscriptions.transferred_to_subscription_id),
        isNull(kiloclaw_instances.organization_id)
      )
    )
    .limit(1);

  // Reject if subscription is active, past_due, or unpaid (spec rule 1)
  if (existingSub && existingSub.status !== 'trialing' && existingSub.status !== 'canceled') {
    throw new Error('Cannot enroll: an active subscription already exists. Cancel it first.');
  }

  const isLiveTrialLineage = existingSub?.status === 'trialing';
  const kiloclawPriceVersion = isLiveTrialLineage
    ? existingSub.kiloclaw_price_version
    : CURRENT_KILOCLAW_PRICE_VERSION;
  const kiloclawPricing = getKiloClawPricingCatalogEntry(kiloclawPriceVersion);

  // First-time standard-plan subscribers in an eligible live pre-rollout lineage
  // get that version's intro price. Current and canceled-history enrollments use
  // recurring pricing from the first paid period. Commit has no intro discount.
  // See spec Credit Enrollment rule 3.
  const useStandardIntro =
    isLiveTrialLineage &&
    plan === 'standard' &&
    kiloclawPricing.standardIntroMicrodollars !== undefined &&
    !hadPaidSubscription;
  const costMicrodollars = getKiloClawPlanCostMicrodollars({
    priceVersion: kiloclawPriceVersion,
    plan,
    useStandardIntro,
  });
  const saleItemSku = useStandardIntro
    ? getStripePriceIdForClawPlanIntro('standard', { priceVersion: kiloclawPriceVersion })
    : getStripePriceIdForClawPlan(plan, { priceVersion: kiloclawPriceVersion });

  // Save suspension state for post-transaction auto-resume (spec rule 4)
  const wasSuspended = !!existingSub?.suspended_at;

  // Step 2: Check effective balance (spec rule 3)
  // Effective balance = raw balance + projected Kilo Pass bonus that would
  // be awarded after the deduction by maybeIssueKiloPassBonusFromUsageThreshold.
  // The deduction increments microdollars_used, so project the post-deduction
  // value to correctly evaluate whether the spend crosses the bonus threshold.
  const balance = user.total_microdollars_acquired - user.microdollars_used;
  const { effectiveBalanceMicrodollars: effectiveBalance } = await getEffectiveCreditBalancePreview(
    {
      userId,
      balanceMicrodollars: balance,
      microdollarsUsed: user.microdollars_used,
      kiloPassThreshold: user.kilo_pass_threshold,
      costMicrodollars,
    }
  );

  if (effectiveBalance < costMicrodollars) {
    const shortfall = costMicrodollars - effectiveBalance;
    throw new Error(
      `Insufficient credit balance. You need ${shortfall} more microdollars to enroll.`
    );
  }

  // Step 3: Single DB transaction (spec rule 5)
  const now = new Date();
  const periodMonths = plan === 'commit' ? 6 : 1;
  const periodEnd = addMonths(now, periodMonths);
  const periodStartIso = now.toISOString();
  const periodEndIso = periodEnd.toISOString();
  const periodKey = format(now, 'yyyy-MM');
  const categoryPrefix =
    plan === 'commit'
      ? `kiloclaw-subscription-commit:${instanceId}`
      : `kiloclaw-subscription:${instanceId}`;
  const deductionCategory = `${categoryPrefix}:${periodKey}`;
  const saleDedupeKeyEntityId = deductionCategory;

  let deductionWasDuplicate = false;
  const trialEndEntityId = existingSub?.status === 'trialing' ? existingSub.id : undefined;

  await db.transaction(async tx => {
    // 5a: Insert negative credit transaction with period-encoded idempotency key
    const deductionResult = await tx
      .insert(credit_transactions)
      .values({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        amount_microdollars: -costMicrodollars,
        is_free: false,
        description: `KiloClaw ${plan} enrollment`,
        credit_category: deductionCategory,
        check_category_uniqueness: true,
        original_baseline_microdollars_used: user.microdollars_used,
      })
      .onConflictDoNothing();

    const deductionIsNew = (deductionResult.rowCount ?? 0) > 0;

    if (!deductionIsNew) {
      // Duplicate key from prior committed transaction — abort as duplicate attempt
      logInfo('Duplicate credit enrollment attempt', {
        user_id: userId,
        instanceId,
        deductionCategory,
      });
      deductionWasDuplicate = true;
      return;
    }

    // 5b: Atomically increment microdollars_used so the deduction counts
    //     as spend toward the Kilo Pass bonus unlock threshold.
    await tx
      .update(kilocode_users)
      .set({
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${costMicrodollars}`,
      })
      .where(eq(kilocode_users.id, userId));

    const [currentSubscription] = await tx
      .select()
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, userId),
          eq(kiloclaw_subscriptions.instance_id, instanceId),
          isNull(kiloclaw_subscriptions.transferred_to_subscription_id)
        )
      )
      .limit(1);

    // 5c: Upsert subscription row as pure credit
    const commitEndsAt = plan === 'commit' ? periodEndIso : null;
    const [mutatedSubscription] = await tx
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: userId,
        instance_id: instanceId,
        payment_source: 'credits',
        status: 'active',
        plan,
        kiloclaw_price_version: kiloclawPriceVersion,
        current_period_start: periodStartIso,
        current_period_end: periodEndIso,
        credit_renewal_at: periodEndIso,
        stripe_subscription_id: null,
        commit_ends_at: commitEndsAt,
        past_due_since: null,
        cancel_at_period_end: false,
        trial_started_at: null,
        trial_ends_at: null,
        ...PAID_ACTIVATION_LIFECYCLE_CLEAR_SET,
        ...(wasSuspended ? PAID_AUTO_RESUME_INITIAL_STATE : {}),
      })
      .onConflictDoUpdate({
        target: kiloclaw_subscriptions.instance_id,
        targetWhere: isNotNull(kiloclaw_subscriptions.instance_id),
        set: {
          payment_source: 'credits',
          status: 'active',
          plan,
          kiloclaw_price_version: kiloclawPriceVersion,
          current_period_start: periodStartIso,
          current_period_end: periodEndIso,
          credit_renewal_at: periodEndIso,
          stripe_subscription_id: null,
          commit_ends_at: commitEndsAt,
          past_due_since: null,
          cancel_at_period_end: false,
          ...PAID_ACTIVATION_LIFECYCLE_CLEAR_SET,
          ...(wasSuspended ? PAID_AUTO_RESUME_INITIAL_STATE : {}),
        },
      })
      .returning();

    if (mutatedSubscription) {
      const action: KiloClawSubscriptionChangeAction = currentSubscription
        ? 'payment_source_changed'
        : 'created';
      await insertKiloClawSubscriptionChangeLog(tx, {
        subscriptionId: mutatedSubscription.id,
        actor: params.actor ?? CREDIT_BILLING_ACTOR,
        action,
        reason: 'credit_enrollment',
        before: currentSubscription ?? null,
        after: mutatedSubscription,
      });
    }
  });

  if (deductionWasDuplicate) {
    try {
      await enqueueCreditEnrollmentAffiliateEvents({
        userId,
        plan,
        saleEntityId: saleDedupeKeyEntityId,
        saleOrderId: deductionCategory,
        saleAmountMicrodollars: costMicrodollars,
        eventDate: now,
        saleItemSku,
        priceVersion: kiloclawPriceVersion,
        trialEndEntityId,
      });
    } catch (error) {
      logWarning('Affiliate enqueue recovery failed after duplicate credit enrollment', {
        user_id: userId,
        instanceId,
        deductionCategory,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    throw new Error('Enrollment already processed for this billing period.');
  }

  try {
    await enqueueCreditEnrollmentAffiliateEvents({
      userId,
      plan,
      saleEntityId: saleDedupeKeyEntityId,
      saleOrderId: deductionCategory,
      saleAmountMicrodollars: costMicrodollars,
      eventDate: now,
      saleItemSku,
      priceVersion: kiloclawPriceVersion,
      trialEndEntityId,
    });
  } catch (error) {
    logWarning('Affiliate enqueue failed after credit enrollment', {
      user_id: userId,
      instanceId,
      deductionCategory,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 4: Post-transaction bonus evaluation (spec rule 6)
  try {
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: userId,
      nowIso: new Date().toISOString(),
    });
  } catch (error) {
    logError('Kilo Pass bonus evaluation failed after credit enrollment', {
      user_id: userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Step 5: Auto-resume if suspended (spec rule 7)
  if (existingSub?.plan === 'trial' && existingSub.status === 'trialing') {
    try {
      await clearTrialInactivityStopAfterTrialTransition({
        kiloUserId: userId,
        instanceId,
      });
    } catch (error) {
      logWarning('Failed to clear trial inactivity marker after credit enrollment', {
        user_id: userId,
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (wasSuspended && instanceId) {
    await autoResumeIfSuspended(userId, instanceId);
  }

  if (shouldSendSubscriptionStartedEmailForActivation(existingSub?.status ?? null)) {
    await maybeSendKiloClawSubscriptionStartedEmail({
      userId,
      instanceId,
      plan,
      amountCents: Math.round(costMicrodollars / 10_000),
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
    });
  }

  logInfo('Credit enrollment completed', {
    user_id: userId,
    instanceId,
    plan,
    costMicrodollars,
  });
}
