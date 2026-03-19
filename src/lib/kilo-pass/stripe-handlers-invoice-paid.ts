import 'server-only';

import {
  credit_transactions,
  kilo_pass_issuances,
  kilo_pass_scheduled_changes,
  kilo_pass_subscriptions,
  kilocode_users,
} from '@kilocode/db/schema';

import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';

import { KILO_PASS_TIER_CONFIG } from '@/lib/kilo-pass/constants';
import { KiloPassError } from '@/lib/kilo-pass/errors';
import {
  appendKiloPassAuditLog,
  createOrGetIssuanceHeader,
  issueBaseCreditsForIssuance,
} from '@/lib/kilo-pass/issuance';
import { forceImmediateExpirationRecomputation } from '@/lib/balanceCache';
import {
  getKiloPassMetadataFromStripeMetadata,
  getKiloPassPriceMetadataFromInvoice,
  getKiloPassSubscriptionMetadata,
} from '@/lib/kilo-pass/stripe-handlers-metadata';
import { invoiceLooksLikeKiloPassByPriceId } from '@/lib/kilo-pass/stripe-invoice-classifier.server';
import {
  getInvoiceIssueMonth,
  getInvoiceSubscription,
  getPreviousIssueMonth,
  getStripeEndedAtIso,
} from '@/lib/kilo-pass/stripe-handlers-utils';
import { toMicrodollars } from '@/lib/utils';
import type Stripe from 'stripe';
import { dayjs } from '@/lib/kilo-pass/dayjs';
import {
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassCadence,
  KiloPassIssuanceSource,
} from '@/lib/kilo-pass/enums';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { processTopUp } from '@/lib/credits';
import { randomUUID } from 'node:crypto';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';

async function maybeIssueYearlyRemainingCredits(params: {
  tx: DrizzleTransaction;
  stripe: Stripe;
  stripeEventId: string;
  stripeInvoiceId: string;
  scheduledChangeId: string;
}): Promise<boolean> {
  const { tx, stripe, stripeEventId, stripeInvoiceId, scheduledChangeId } = params;

  const row = await tx.query.kilo_pass_scheduled_changes.findFirst({
    where: and(
      eq(kilo_pass_scheduled_changes.id, scheduledChangeId),
      isNull(kilo_pass_scheduled_changes.deleted_at)
    ),
  });

  if (!row) {
    return false;
  }

  const fromPrice = KILO_PASS_TIER_CONFIG[row.from_tier].monthlyPriceUsd;
  const toPrice = KILO_PASS_TIER_CONFIG[row.to_tier].monthlyPriceUsd;
  const isYearly =
    row.from_cadence === KiloPassCadence.Yearly && row.to_cadence === KiloPassCadence.Yearly;

  if (!isYearly || toPrice < fromPrice) return false;

  const subscription = await tx.query.kilo_pass_subscriptions.findFirst({
    columns: {
      id: true,
    },
    where: eq(kilo_pass_subscriptions.stripe_subscription_id, row.stripe_subscription_id),
  });

  const subscriptionId = subscription?.id ?? null;
  if (!subscriptionId) return false;

  const effectiveAtUtc = dayjs(row.effective_at).utc();
  if (!effectiveAtUtc.isValid()) return false;

  // Determine the start of the current yearly billing cycle from the most recent
  // yearly invoice on this Stripe subscription. This is reliable across cadence
  // changes (where billing_cycle_anchor: 'phase_start' resets the cycle) and
  // subscription gaps, unlike computing from started_at.
  const recentInvoices = await stripe.invoices.list({
    subscription: row.stripe_subscription_id,
    limit: 12,
    status: 'paid',
  });

  // Find the invoice that started the current yearly billing cycle: the most recent
  // paid invoice whose line item has a yearly interval and whose period contains
  // the effective date.
  let yearlyBillingCycleStartSeconds: number | null = null;
  for (const inv of recentInvoices.data) {
    // Skip the invoice that triggered this handler — we want the *previous*
    // yearly invoice that started the billing cycle, not the upgrade invoice.
    if (inv.id === stripeInvoiceId) continue;

    const lineItem = inv.lines?.data?.[0];
    if (!lineItem) continue;

    const periodStart = lineItem.period?.start;
    const periodEnd = lineItem.period?.end;
    if (typeof periodStart !== 'number' || typeof periodEnd !== 'number') continue;

    // Skip non-yearly invoices: yearly periods span ~365 days (340 allows
    // for leap-year and Stripe timestamp rounding while staying well above
    // the longest monthly period of ~31 days).
    const periodDays = (periodEnd - periodStart) / 86400;
    if (periodDays < 340) continue;

    // The yearly invoice whose period contains the effective date
    if (effectiveAtUtc.unix() >= periodStart && effectiveAtUtc.unix() <= periodEnd) {
      yearlyBillingCycleStartSeconds = periodStart;
      break;
    }
  }

  if (yearlyBillingCycleStartSeconds === null) {
    // Fallback: if no matching yearly invoice found, use the effective date
    // minus 12 months (conservative — may slightly overcount).
    yearlyBillingCycleStartSeconds = effectiveAtUtc.subtract(12, 'month').unix();
  }

  const cycleStartUtc = dayjs.unix(yearlyBillingCycleStartSeconds).utc();
  const monthsElapsed = Math.max(0, effectiveAtUtc.diff(cycleStartUtc, 'month'));
  const remainingMonths = monthsElapsed >= 12 ? 0 : 12 - monthsElapsed;
  const monthlyPriceUsd = KILO_PASS_TIER_CONFIG[row.from_tier].monthlyPriceUsd;
  const remainingBaseUsd = remainingMonths * monthlyPriceUsd;

  if (remainingBaseUsd <= 0) return false;

  const syntheticStripeInvoiceId = `kilo-pass-yearly-remaining:${row.id}`;
  const amountCents = Math.round(remainingBaseUsd * 100);

  const user = (
    await tx.select().from(kilocode_users).where(eq(kilocode_users.id, row.kilo_user_id)).limit(1)
  )[0];
  if (!user) {
    throw new Error(
      `User not found for yearly remaining credits issuance: kilo_user_id=${row.kilo_user_id}`
    );
  }

  const attemptedCreditTransactionId = randomUUID();
  const topUpOk = await processTopUp(
    user,
    amountCents,
    {
      type: 'stripe',
      stripe_payment_id: syntheticStripeInvoiceId,
    },
    {
      dbOrTx: tx,
      creditTransactionId: attemptedCreditTransactionId,
      creditDescription: `Kilo Pass yearly remaining base credits (${row.from_tier}, remaining_months=${remainingMonths})`,
      skipPostTopUpFreeStuff: true,
    }
  );

  let existingCreditTransactionId;
  if (!topUpOk) {
    existingCreditTransactionId = (
      await tx
        .select({ id: credit_transactions.id })
        .from(credit_transactions)
        .where(eq(credit_transactions.stripe_payment_id, syntheticStripeInvoiceId))
        .limit(1)
    )[0]?.id;
  }

  await appendKiloPassAuditLog(tx, {
    action: KiloPassAuditLogAction.IssueYearlyRemainingCredits,
    result: topUpOk ? KiloPassAuditLogResult.Success : KiloPassAuditLogResult.SkippedIdempotent,
    kiloUserId: row.kilo_user_id,
    kiloPassSubscriptionId: subscriptionId,
    stripeEventId,
    stripeSubscriptionId: row.stripe_subscription_id,
    stripeInvoiceId: syntheticStripeInvoiceId,
    relatedCreditTransactionId: topUpOk
      ? attemptedCreditTransactionId
      : (existingCreditTransactionId ?? null),
    payload: {
      kind: 'yearly_remaining_base',
      triggeringStripeInvoiceId: stripeInvoiceId,
      scheduledChangeId: row.id,
      fromTier: row.from_tier,
      effectiveAt: row.effective_at,
      monthsElapsed,
      remainingMonths,
      remainingBaseUsd,
    },
  });

  return true;
}

export async function handleKiloPassInvoicePaid(params: {
  eventId: string;
  invoice: Stripe.Invoice;
  stripe: Stripe;
}): Promise<void> {
  const { eventId, invoice, stripe } = params;

  // Strong predicate: classify Kilo Pass invoices using our known Kilo Pass price IDs.
  if (!invoiceLooksLikeKiloPassByPriceId(invoice)) return;

  let didMutateBalance = false;
  let kiloUserIdForCache: string | null = null;

  // Track context for failure audit logging
  let kiloUserIdForAudit: string | null = null;
  let kiloPassSubscriptionIdForAudit: string | null = null;
  let stripeSubscriptionIdForAudit: string | null = null;

  try {
    await db.transaction(async tx => {
      const metadataFromInvoice = getKiloPassMetadataFromStripeMetadata(
        invoice.parent?.subscription_details?.metadata
      );

      const subscription = await getInvoiceSubscription({ invoice, stripe });
      if (!subscription) {
        throw new KiloPassError('Kilo Pass invoice has no subscription reference', {
          stripe_event_id: eventId,
          stripe_invoice_id: invoice.id,
        });
      }

      const metadata = metadataFromInvoice ?? getKiloPassSubscriptionMetadata(subscription);
      if (!metadata) {
        throw new KiloPassError('Kilo Pass invoice has no metadata', {
          stripe_event_id: eventId,
          stripe_invoice_id: invoice.id,
          stripe_subscription_id: subscription.id,
        });
      }

      if (metadata.kiloPassScheduledChangeId) {
        const didIssueYearlyRemainingCredits = await maybeIssueYearlyRemainingCredits({
          tx,
          stripe,
          stripeEventId: eventId,
          stripeInvoiceId: invoice.id,
          scheduledChangeId: metadata.kiloPassScheduledChangeId,
        });

        // After the scheduled-change invoice is paid, release the schedule so the subscription
        // continues without a pending schedule.
        await releaseScheduledChangeForSubscription({
          dbOrTx: tx,
          stripe,
          stripeEventId: eventId,
          stripeSubscriptionId: subscription.id,
          reason: didIssueYearlyRemainingCredits
            ? 'issue_yearly_remaining_credits'
            : 'invoice_paid',
        });
      }

      const priceMetadata = getKiloPassPriceMetadataFromInvoice(invoice);

      const kiloUserId = metadata.kiloUserId;
      const tier = priceMetadata?.tier ?? metadata.tier;
      const cadence = priceMetadata?.cadence ?? metadata.cadence;

      kiloUserIdForCache = kiloUserId;
      kiloUserIdForAudit = kiloUserId;
      stripeSubscriptionIdForAudit = subscription.id;

      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.StripeWebhookReceived,
        result: KiloPassAuditLogResult.Success,
        kiloUserId,
        stripeEventId: eventId,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscription.id,
        payload: { type: 'invoice.paid' },
      });

      const issueMonth = getInvoiceIssueMonth(invoice);

      const existingSubscription = await tx.query.kilo_pass_subscriptions.findFirst({
        where: eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.id),
      });

      // Derive status and ended_at from the actual Stripe subscription to avoid
      // out-of-order events incorrectly "resurrecting" a canceled subscription.
      const subscriptionIsEnded = isStripeSubscriptionEnded(subscription.status);
      const derivedEndedAt = subscriptionIsEnded ? getStripeEndedAtIso(subscription) : null;

      const upserted = await tx
        .insert(kilo_pass_subscriptions)
        .values({
          kilo_user_id: kiloUserId,
          stripe_subscription_id: subscription.id,
          tier,
          cadence,
          status: subscription.status,
          started_at: dayjs.unix(subscription.start_date).utc().toISOString(),
          ended_at: derivedEndedAt,
        })
        .onConflictDoUpdate({
          target: kilo_pass_subscriptions.stripe_subscription_id,
          set: {
            kilo_user_id: kiloUserId,
            tier,
            cadence,
            status: subscription.status,
            ended_at: derivedEndedAt,
          },
        })
        .returning({
          id: kilo_pass_subscriptions.id,
          status: kilo_pass_subscriptions.status,
        });

      const row = upserted[0];
      if (!row) {
        throw new KiloPassError('Failed to upsert kilo_pass_subscriptions row', {
          stripe_event_id: eventId,
          stripe_invoice_id: invoice.id,
          stripe_subscription_id: subscription.id,
          kilo_user_id: kiloUserId,
        });
      }

      const kiloPassSubscriptionId = row.id;
      kiloPassSubscriptionIdForAudit = kiloPassSubscriptionId;
      const priorStatus = existingSubscription?.status ?? null;

      const issuanceHeader = await createOrGetIssuanceHeader(tx, {
        subscriptionId: kiloPassSubscriptionId,
        issueMonth,
        source: KiloPassIssuanceSource.StripeInvoice,
        stripeInvoiceId: invoice.id,
      });

      await appendKiloPassAuditLog(tx, {
        action: KiloPassAuditLogAction.KiloPassInvoicePaidHandled,
        result: KiloPassAuditLogResult.Success,
        kiloUserId,
        kiloPassSubscriptionId,
        stripeEventId: eventId,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscription.id,
        relatedMonthlyIssuanceId: issuanceHeader.issuanceId,
        payload: {
          issueMonth,
          tier,
          cadence,
          ...(priceMetadata ? { priceId: priceMetadata.priceId } : {}),
          issuanceHeaderWasCreated: issuanceHeader.wasCreated,
        },
      });

      // Base credits are determined by the tier's monthly price, not the invoice amount.
      // This ensures credits are consistent regardless of tax, discounts, or proration.
      //
      // For yearly cadence, we still bill yearly, but issue base credits monthly.
      const tierConfig = KILO_PASS_TIER_CONFIG[tier];
      const baseAmountUsd = tierConfig.monthlyPriceUsd;

      const baseCreditsResult = await issueBaseCreditsForIssuance(tx, {
        issuanceId: issuanceHeader.issuanceId,
        subscriptionId: kiloPassSubscriptionId,
        kiloUserId,
        amountUsd: baseAmountUsd,
        stripeInvoiceId: invoice.id,
        description: `Kilo Pass base credits (${tier}, ${cadence})`,
      });
      didMutateBalance ||= baseCreditsResult.wasIssued;

      if (baseCreditsResult.wasIssued) {
        await tx
          .update(kilocode_users)
          .set({
            // Bonus credits are issued later (on usage), after the user has consumed one month of base credits.
            kilo_pass_threshold: sql`${kilocode_users.microdollars_used} + ${toMicrodollars(tierConfig.monthlyPriceUsd)}`,
          })
          .where(eq(kilocode_users.id, kiloUserId));
      }

      if (cadence === KiloPassCadence.Yearly) {
        const paidAtSeconds =
          invoice.status_transitions?.paid_at ?? invoice.created ?? invoice.period_start ?? null;
        if (paidAtSeconds === null) {
          throw new Error(
            `Invoice ${invoice.id} missing paid_at/created/period_start timestamps (required for yearly next_yearly_issue_at scheduling)`
          );
        }

        const paidAt = dayjs.unix(paidAtSeconds).utc();
        const nextDueAtIso = paidAt.add(1, 'month').toISOString();

        const existingNextYearlyIssueAt = existingSubscription?.next_yearly_issue_at ?? null;
        const nextYearlyIssueAtToSet =
          existingNextYearlyIssueAt !== null && existingNextYearlyIssueAt > nextDueAtIso
            ? existingNextYearlyIssueAt
            : nextDueAtIso;

        await tx
          .update(kilo_pass_subscriptions)
          .set({
            next_yearly_issue_at: nextYearlyIssueAtToSet,
            // Yearly cadence has no streak.
            current_streak_months: 0,
          })
          .where(eq(kilo_pass_subscriptions.id, kiloPassSubscriptionId));
        return;
      }

      const wasInactivePreviously = priorStatus !== null && isStripeSubscriptionEnded(priorStatus);

      const issuanceMonths = await tx
        .select({ issueMonth: kilo_pass_issuances.issue_month })
        .from(kilo_pass_issuances)
        .where(
          and(
            eq(kilo_pass_issuances.kilo_pass_subscription_id, kiloPassSubscriptionId),
            lte(kilo_pass_issuances.issue_month, issueMonth)
          )
        )
        .orderBy(desc(kilo_pass_issuances.issue_month))
        .limit(24);

      const issueMonthSet = new Set(issuanceMonths.map(x => x.issueMonth));

      let computedStreak = 0;
      let cursor = issueMonth;
      while (issueMonthSet.has(cursor)) {
        computedStreak += 1;
        cursor = getPreviousIssueMonth(cursor);
      }

      const newStreakMonths = wasInactivePreviously ? 1 : Math.max(1, computedStreak);

      await tx
        .update(kilo_pass_subscriptions)
        .set({ current_streak_months: newStreakMonths, next_yearly_issue_at: null })
        .where(eq(kilo_pass_subscriptions.id, kiloPassSubscriptionId));
    });
  } catch (error) {
    // Write failure audit log outside the transaction (non-transactional)
    // so it persists even when the transaction rolls back.
    await appendKiloPassAuditLog(db, {
      action: KiloPassAuditLogAction.KiloPassInvoicePaidHandled,
      result: KiloPassAuditLogResult.Failed,
      kiloUserId: kiloUserIdForAudit,
      kiloPassSubscriptionId: kiloPassSubscriptionIdForAudit,
      stripeEventId: eventId,
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId: stripeSubscriptionIdForAudit,
      payload: {
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }

  if (didMutateBalance && kiloUserIdForCache !== null) {
    await forceImmediateExpirationRecomputation(kiloUserIdForCache);
  }
}
