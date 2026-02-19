import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import { client as stripe } from '@/lib/stripe-client';
import { getStripePriceIdForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { APP_URL } from '@/lib/constants';
import { TRPCError } from '@trpc/server';
import {
  kilo_pass_issuance_items,
  kilo_pass_issuances,
  kilo_pass_scheduled_changes,
  kilo_pass_subscriptions,
  microdollar_usage,
} from '@/db/schema';
import {
  KiloPassCadence,
  KiloPassAuditLogAction,
  KiloPassAuditLogResult,
  KiloPassScheduledChangeStatus,
  KiloPassTier,
} from '@/lib/kilo-pass/enums';
import { KiloPassIssuanceItemKind } from '@/lib/kilo-pass/enums';
import { and, desc, eq, inArray, isNull, ne, sql, sum } from 'drizzle-orm';
import * as z from 'zod';
import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from '@/lib/kilo-pass/bonus';
import { KiloPassError } from '@/lib/kilo-pass/errors';
import { isStripeSubscriptionEnded } from '@/lib/kilo-pass/stripe-subscription-status';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';
import { appendKiloPassAuditLog } from '@/lib/kilo-pass/issuance';
import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
} from '@/lib/kilo-pass/constants';
import { fromMicrodollars } from '@/lib/utils';
import type Stripe from 'stripe';
import { dayjs } from '@/lib/kilo-pass/dayjs';

const KiloPassTierSchema = z.enum(KiloPassTier);

const KiloPassCadenceSchema = z.enum(KiloPassCadence);

const KiloPassSubscriptionStatusSchema = z.union([
  z.literal('active'),
  z.literal('canceled'),
  z.literal('incomplete'),
  z.literal('incomplete_expired'),
  z.literal('past_due'),
  z.literal('paused'),
  z.literal('trialing'),
  z.literal('unpaid'),
]);

const KiloPassSubscriptionStateBaseSchema = z.object({
  subscriptionId: z.string(),
  stripeSubscriptionId: z.string(),
  tier: KiloPassTierSchema,
  cadence: KiloPassCadenceSchema,
  status: KiloPassSubscriptionStatusSchema,
  cancelAtPeriodEnd: z.boolean(),
  currentStreakMonths: z.number(),
  nextYearlyIssueAt: z.string().nullable(),
  startedAt: z.string().nullable(),
});

const KiloPassSubscriptionStateSchema = KiloPassSubscriptionStateBaseSchema.extend({
  nextBonusCreditsUsd: z.number().nullable(),
  nextBillingAt: z.string().nullable(),

  /** True if the user has never had any other Kilo Pass subscription. */
  isFirstTimeSubscriberEver: z.boolean(),

  /** Derived, per-current-period values used for the profile card UI */
  currentPeriodBaseCreditsUsd: z.number(),
  currentPeriodUsageUsd: z.number(),
  currentPeriodBonusCreditsUsd: z.number().nullable(),
  isBonusUnlocked: z.boolean(),
  refillAt: z.string().nullable(),
});

const GetStateOutputSchema = z.object({
  subscription: KiloPassSubscriptionStateSchema.nullable(),
});

const GetAverageMonthlyUsageLast3MonthsOutputSchema = z.object({
  averageMonthlyUsageUsd: z.number(),
});

function roundToCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function secondsToIso(seconds: number): string {
  return dayjs.unix(seconds).utc().toISOString();
}

function getStripePeriodEndSeconds(subscription: Stripe.Subscription): number | null {
  return subscription.items.data[0]?.current_period_end ?? null;
}

function getStripePeriodStartSeconds(subscription: Stripe.Subscription): number | null {
  return subscription.items.data[0]?.current_period_start ?? null;
}

async function getIsFirstTimeSubscriberEver(params: {
  kiloUserId: string;
  stripeSubscriptionId: string;
}): Promise<boolean> {
  const otherSubscriptions = await db
    .select({ id: kilo_pass_subscriptions.id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.kilo_user_id, params.kiloUserId),
        ne(kilo_pass_subscriptions.stripe_subscription_id, params.stripeSubscriptionId)
      )
    )
    .limit(1);

  return otherSubscriptions.length === 0;
}

async function getIsBonusUnlockedForSubscriptionId(subscriptionId: string): Promise<boolean> {
  const lastIssuance = await db
    .select({ id: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId))
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const issuanceId = lastIssuance[0]?.id;
  if (!issuanceId) return false;

  const unlockedItem = await db.query.kilo_pass_issuance_items.findFirst({
    columns: { id: true },
    where: and(
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, issuanceId),
      inArray(kilo_pass_issuance_items.kind, [
        KiloPassIssuanceItemKind.Bonus,
        KiloPassIssuanceItemKind.PromoFirstMonth50Pct,
      ])
    ),
  });

  return Boolean(unlockedItem);
}

/**
 * Get the timestamp when base credits were issued for the most recent issuance of a subscription.
 *
 * The Kilo Pass usage window should start from when base credits were actually issued (via the
 * invoice.paid webhook), not from Stripe's `current_period_start`. There is often a gap between
 * these two timestamps during which usage is served from pre-existing credits, not pass credits.
 */
async function getBaseCreditsIssuedAtForSubscription(
  subscriptionId: string
): Promise<string | null> {
  const rows = await db
    .select({ createdAt: kilo_pass_issuance_items.created_at })
    .from(kilo_pass_issuance_items)
    .innerJoin(
      kilo_pass_issuances,
      eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
    )
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, subscriptionId),
        eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
      )
    )
    .orderBy(desc(kilo_pass_issuances.issue_month))
    .limit(1);

  const row = rows[0];
  if (!row?.createdAt) return null;

  const parsed = dayjs(row.createdAt).utc();
  return parsed.isValid() ? parsed.toISOString() : null;
}

async function getCurrentPeriodUsageUsd(params: {
  kiloUserId: string;
  startInclusiveIso: string;
  endExclusiveIso: string;
}): Promise<number> {
  const result = await db
    .select({
      totalCost_mUsd: sql<unknown>`COALESCE(${sum(microdollar_usage.cost)}, 0)`,
    })
    .from(microdollar_usage)
    .where(
      and(
        eq(microdollar_usage.kilo_user_id, params.kiloUserId),
        isNull(microdollar_usage.organization_id),
        sql`${microdollar_usage.created_at} >= ${params.startInclusiveIso}`,
        sql`${microdollar_usage.created_at} < ${params.endExclusiveIso}`
      )
    );

  const raw = Number(result[0]?.totalCost_mUsd);
  const totalCost_mUsd = isNaN(raw) ? 0 : raw;
  return roundToCents(fromMicrodollars(totalCost_mUsd));
}

const GetCheckoutReturnStateOutputSchema = z.object({
  subscription: KiloPassSubscriptionStateBaseSchema.nullable(),
  creditsAwarded: z.boolean(),
});

const CreateCheckoutSessionInputSchema = z.object({
  tier: KiloPassTierSchema,
  cadence: KiloPassCadenceSchema,
});

const CreateCheckoutSessionOutputSchema = z.object({
  url: z.url().nullable(),
});

const FirstMonthPromoEligibilityOutputSchema = z.object({
  eligible: z.boolean(),
});

const CancelSubscriptionOutputSchema = z.object({
  success: z.boolean(),
});

const ScheduleChangeInputSchema = z.object({
  targetTier: KiloPassTierSchema,
  targetCadence: KiloPassCadenceSchema,
});

const ScheduleChangeOutputSchema = z.object({
  scheduledChangeId: z.string(),
  effectiveAt: z.string(),
});

const CancelScheduledChangeOutputSchema = z.object({
  success: z.boolean(),
});

const ScheduledChangeStatusSchema = z.enum(KiloPassScheduledChangeStatus);

const GetScheduledChangeOutputSchema = z.object({
  scheduledChange: z
    .object({
      id: z.string(),
      fromTier: KiloPassTierSchema,
      fromCadence: KiloPassCadenceSchema,
      toTier: KiloPassTierSchema,
      toCadence: KiloPassCadenceSchema,
      effectiveAt: z.string(),
      status: ScheduledChangeStatusSchema,
    })
    .nullable(),
});

export const kiloPassRouter = createTRPCRouter({
  getAverageMonthlyUsageLast3Months: baseProcedure
    .output(GetAverageMonthlyUsageLast3MonthsOutputSchema)
    .query(async ({ ctx }) => {
      // Use last 3 months from now (rolling window).
      const startInclusive = sql`(NOW() - INTERVAL '3 months')`;

      const result = await db
        .select({
          totalCost_mUsd: sql<unknown>`COALESCE(${sum(microdollar_usage.cost)}, 0)`,
        })
        .from(microdollar_usage)
        .where(
          and(
            eq(microdollar_usage.kilo_user_id, ctx.user.id),
            isNull(microdollar_usage.organization_id),
            sql`${microdollar_usage.created_at} >= ${startInclusive}`
          )
        );

      const totalCostRaw = Number(result[0]?.totalCost_mUsd);
      const totalCost_mUsd = isNaN(totalCostRaw) ? 0 : totalCostRaw;

      const averageMonthlyUsageUsd = roundToCents(fromMicrodollars(totalCost_mUsd) / 3);
      return { averageMonthlyUsageUsd };
    }),

  getState: baseProcedure.output(GetStateOutputSchema).query(async ({ ctx }) => {
    const subscriptionBase = await getKiloPassStateForUser(db, ctx.user.id);
    if (!subscriptionBase) {
      return { subscription: null };
    }

    const stripeCustomerId = ctx.user.stripe_customer_id;
    if (!stripeCustomerId) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
    }

    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscriptionBase.stripeSubscriptionId
    );

    const isFirstTimeSubscriberEver = await getIsFirstTimeSubscriberEver({
      kiloUserId: ctx.user.id,
      stripeSubscriptionId: subscriptionBase.stripeSubscriptionId,
    });

    if (isStripeSubscriptionEnded(stripeSubscription.status)) {
      const baseAmountUsd = getMonthlyPriceUsd(subscriptionBase.tier);

      return {
        subscription: {
          ...subscriptionBase,
          status: stripeSubscription.status,
          nextBonusCreditsUsd: null,
          nextBillingAt: null,

          isFirstTimeSubscriberEver,

          currentPeriodBaseCreditsUsd: baseAmountUsd,
          currentPeriodUsageUsd: 0,
          currentPeriodBonusCreditsUsd: null,
          isBonusUnlocked: false,
          refillAt: null,
        },
      };
    }

    const periodEndSeconds = getStripePeriodEndSeconds(stripeSubscription);
    if (typeof periodEndSeconds !== 'number') {
      throw new KiloPassError(
        `Stripe subscription missing billing period end: subscription=${stripeSubscription.id} status=${stripeSubscription.status}`,
        {
          kilo_user_id: ctx.user.id,
          stripe_subscription_id: stripeSubscription.id,
        }
      );
    }

    const periodStartSeconds = getStripePeriodStartSeconds(stripeSubscription);
    if (typeof periodStartSeconds !== 'number') {
      throw new KiloPassError(
        `Stripe subscription missing billing period start: subscription=${stripeSubscription.id} status=${stripeSubscription.status}`,
        {
          kilo_user_id: ctx.user.id,
          stripe_subscription_id: stripeSubscription.id,
        }
      );
    }

    const nextBillingAt = secondsToIso(periodEndSeconds);

    const isBonusUnlocked = await getIsBonusUnlockedForSubscriptionId(
      subscriptionBase.subscriptionId
    );

    let nextBonusCreditsUsd: number | null = null;
    const baseAmountUsd = getMonthlyPriceUsd(subscriptionBase.tier);

    if (subscriptionBase.cadence === KiloPassCadence.Yearly) {
      const usd = computeYearlyCadenceMonthlyBonusUsd(subscriptionBase.tier);
      nextBonusCreditsUsd = roundToCents(usd);
    } else {
      const predictedStreakMonths = Math.max(1, subscriptionBase.currentStreakMonths + 1);
      const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
        tier: subscriptionBase.tier,
        streakMonths: predictedStreakMonths,
        isFirstTimeSubscriberEver,
        subscriptionStartedAtIso: subscriptionBase.startedAt,
      });

      const baseCents = Math.round(baseAmountUsd * 100);
      const bonusCents = Math.round(baseCents * bonusPercentApplied);
      nextBonusCreditsUsd = bonusCents / 100;
    }

    let currentPeriodBonusCreditsUsd: number | null = null;
    if (subscriptionBase.cadence === KiloPassCadence.Yearly) {
      const usd = computeYearlyCadenceMonthlyBonusUsd(subscriptionBase.tier);
      currentPeriodBonusCreditsUsd = roundToCents(usd);
    } else {
      const streakMonths = Math.max(1, subscriptionBase.currentStreakMonths);
      const shouldShowFirstMonthPromo = streakMonths === 1 && isFirstTimeSubscriberEver;

      if (shouldShowFirstMonthPromo) {
        const cents = Math.round(baseAmountUsd * KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT * 100);
        currentPeriodBonusCreditsUsd = cents / 100;
      } else {
        const bonusPercentApplied = computeMonthlyCadenceBonusPercent({
          tier: subscriptionBase.tier,
          streakMonths,
          isFirstTimeSubscriberEver,
          subscriptionStartedAtIso: subscriptionBase.startedAt,
        });
        const cents = Math.round(baseAmountUsd * bonusPercentApplied * 100);
        currentPeriodBonusCreditsUsd = cents / 100;
      }
    }

    const nowUtc = dayjs().utc();
    const nowIso = nowUtc.toISOString();

    // Usage window starts from when base credits were actually issued (credit transaction
    // created_at), not from Stripe's current_period_start. There is a delay between when Stripe
    // advances the billing period and when the invoice.paid webhook fires to issue credits.
    // Usage during that gap is served from pre-existing credits, not pass credits.
    const baseCreditsIssuedAtIso = await getBaseCreditsIssuedAtForSubscription(
      subscriptionBase.subscriptionId
    );
    let usageStartInclusiveIso = baseCreditsIssuedAtIso ?? secondsToIso(periodStartSeconds);
    if (subscriptionBase.cadence === KiloPassCadence.Yearly) {
      const nextYearlyIssueAtUtc =
        subscriptionBase.nextYearlyIssueAt != null
          ? dayjs(subscriptionBase.nextYearlyIssueAt).utc()
          : null;

      if (nextYearlyIssueAtUtc?.isValid() && nowUtc.isBefore(nextYearlyIssueAtUtc)) {
        usageStartInclusiveIso = nextYearlyIssueAtUtc.subtract(1, 'month').toISOString();
      } else if (subscriptionBase.startedAt != null) {
        const startedAtUtc = dayjs(subscriptionBase.startedAt).utc();
        if (startedAtUtc.isValid()) {
          const monthsElapsed = Math.max(0, nowUtc.diff(startedAtUtc, 'month'));
          usageStartInclusiveIso = startedAtUtc.add(monthsElapsed, 'month').toISOString();
        }
      }
    }

    const currentPeriodUsageUsd = await getCurrentPeriodUsageUsd({
      kiloUserId: ctx.user.id,
      startInclusiveIso: usageStartInclusiveIso,
      endExclusiveIso: nowIso,
    });

    const refillAt =
      subscriptionBase.cadence === KiloPassCadence.Yearly
        ? (subscriptionBase.nextYearlyIssueAt ?? nextBillingAt)
        : nextBillingAt;

    return {
      subscription: {
        ...subscriptionBase,
        nextBonusCreditsUsd,
        nextBillingAt,

        isFirstTimeSubscriberEver,

        currentPeriodBaseCreditsUsd: baseAmountUsd,
        currentPeriodUsageUsd,
        currentPeriodBonusCreditsUsd,
        isBonusUnlocked,
        refillAt,
      },
    };
  }),

  /**
   * Intended for the Stripe Checkout return flow: poll until the subscription exists and
   * we've issued the initial base credits for that subscription.
   */
  getCheckoutReturnState: baseProcedure
    .output(GetCheckoutReturnStateOutputSchema)
    .query(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        return { subscription: null, creditsAwarded: false };
      }

      const issuedBaseCredits = await db
        .select({ id: kilo_pass_issuance_items.id })
        .from(kilo_pass_issuance_items)
        .innerJoin(
          kilo_pass_issuances,
          eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
        )
        .where(
          and(
            eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription.subscriptionId),
            eq(kilo_pass_issuance_items.kind, KiloPassIssuanceItemKind.Base)
          )
        )
        .limit(1);

      return {
        subscription,
        creditsAwarded: issuedBaseCredits.length > 0,
      };
    }),

  getFirstMonthPromoEligibility: baseProcedure
    .output(FirstMonthPromoEligibilityOutputSchema)
    .query(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);

      return { eligible: !subscription };
    }),

  getCustomerPortalUrl: baseProcedure
    .input(
      z.object({
        returnUrl: z.url().optional(),
      })
    )
    .output(z.object({ url: z.url() }))
    .mutation(async ({ input, ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: input.returnUrl ?? `${APP_URL}/profile`,
      });

      return { url: session.url };
    }),

  cancelSubscription: baseProcedure
    .output(CancelSubscriptionOutputSchema)
    .mutation(async ({ ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }

      // Can only cancel active subscriptions that aren't already pending cancellation
      if (subscription.status !== 'active' || subscription.cancelAtPeriodEnd) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Kilo Pass subscription is not currently active.',
        });
      }

      const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
        columns: {
          stripe_schedule_id: true,
        },
        where: and(
          eq(kilo_pass_scheduled_changes.stripe_subscription_id, subscription.stripeSubscriptionId),
          isNull(kilo_pass_scheduled_changes.deleted_at)
        ),
      });

      if (scheduledChange) {
        await releaseScheduledChangeForSubscription({
          dbOrTx: db,
          stripe,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          stripeScheduleIdIfMissingRow: scheduledChange.stripe_schedule_id,
          kiloUserIdIfMissingRow: ctx.user.id,
          reason: 'cancel_subscription',
        });
      }

      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

      const updated = await db
        .update(kilo_pass_subscriptions)
        .set({ cancel_at_period_end: true })
        .where(
          eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.stripeSubscriptionId)
        )
        .returning({ id: kilo_pass_subscriptions.id });

      if (updated.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update Kilo Pass subscription status.',
        });
      }

      return { success: true };
    }),

  resumeSubscription: baseProcedure
    .output(CancelSubscriptionOutputSchema)
    .mutation(async ({ ctx }) => {
      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing Stripe customer for user.' });
      }

      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }

      if (!subscription.cancelAtPeriodEnd) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Kilo Pass subscription is not pending cancellation.',
        });
      }

      if (isStripeSubscriptionEnded(subscription.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Kilo Pass subscription has already ended.',
        });
      }

      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });

      const updated = await db
        .update(kilo_pass_subscriptions)
        .set({ cancel_at_period_end: false, ended_at: null })
        .where(
          eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.stripeSubscriptionId)
        )
        .returning({ id: kilo_pass_subscriptions.id });

      if (updated.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update Kilo Pass subscription status.',
        });
      }

      return { success: true };
    }),

  getScheduledChange: baseProcedure
    .output(GetScheduledChangeOutputSchema)
    .query(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        return { scheduledChange: null };
      }

      const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
        columns: {
          id: true,
          from_tier: true,
          from_cadence: true,
          to_tier: true,
          to_cadence: true,
          effective_at: true,
          status: true,
        },
        where: and(
          eq(kilo_pass_scheduled_changes.stripe_subscription_id, subscription.stripeSubscriptionId),
          isNull(kilo_pass_scheduled_changes.deleted_at)
        ),
      });

      if (!scheduledChange) {
        return { scheduledChange: null };
      }

      return {
        scheduledChange: {
          id: scheduledChange.id,
          fromTier: scheduledChange.from_tier,
          fromCadence: scheduledChange.from_cadence,
          toTier: scheduledChange.to_tier,
          toCadence: scheduledChange.to_cadence,
          effectiveAt: scheduledChange.effective_at,
          status: scheduledChange.status,
        },
      };
    }),

  scheduleChange: baseProcedure
    .input(ScheduleChangeInputSchema)
    .output(ScheduleChangeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }

      // Only allow scheduling changes for active subscriptions.
      if (subscription.status !== 'active') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Kilo Pass subscription is not active (status=${subscription.status}).`,
        });
      }

      const fromTier = subscription.tier;
      const fromCadence = subscription.cadence;
      const toTier = input.targetTier;
      const toCadence = input.targetCadence;

      if (fromTier === toTier && fromCadence === toCadence) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Target tier/cadence matches current subscription.',
        });
      }

      const fromPrice = KILO_PASS_TIER_CONFIG[fromTier].monthlyPriceUsd;
      const toPrice = KILO_PASS_TIER_CONFIG[toTier].monthlyPriceUsd;
      const isDowntier = toPrice < fromPrice;
      const isUptier = toPrice > fromPrice;
      const isCadenceChange = fromCadence !== toCadence;
      const shouldUseBillingCycleEnd =
        isCadenceChange || isDowntier || (isUptier && fromCadence === KiloPassCadence.Monthly);

      let effectiveAtIso: string;
      let effectiveAtUnix: number;

      if (shouldUseBillingCycleEnd) {
        const stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripeSubscriptionId
        );
        const periodEndSeconds = getStripePeriodEndSeconds(stripeSubscription);
        if (typeof periodEndSeconds !== 'number') {
          throw new KiloPassError(
            `Stripe subscription missing billing period end: subscription=${stripeSubscription.id} status=${stripeSubscription.status}`,
            {
              kilo_user_id: ctx.user.id,
              stripe_subscription_id: stripeSubscription.id,
            }
          );
        }

        effectiveAtIso = secondsToIso(periodEndSeconds);
        effectiveAtUnix = periodEndSeconds;
      } else {
        const nextYearlyIssueAt = subscription.nextYearlyIssueAt ?? null;
        if (!nextYearlyIssueAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Kilo Pass yearly subscription is missing next_yearly_issue_at; cannot schedule change.',
          });
        }

        const parsed = dayjs(nextYearlyIssueAt).utc();
        if (!parsed.isValid()) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid next_yearly_issue_at timestamp: ${nextYearlyIssueAt}`,
          });
        }

        effectiveAtIso = parsed.toISOString();
        effectiveAtUnix = parsed.unix();
      }

      // If there is already an active (non-deleted) schedule for this subscription, release it first.
      // Soft-delete our DB row first; if Stripe release fails we revert.
      await releaseScheduledChangeForSubscription({
        dbOrTx: db,
        stripe,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        kiloUserIdIfMissingRow: ctx.user.id,
        reason: 'schedule_change_replace',
      });

      // Stripe schedule creation (two-phase schedule; switch price at effectiveAt).
      const currentPriceId = getStripePriceIdForKiloPass({ tier: fromTier, cadence: fromCadence });
      const targetPriceId = getStripePriceIdForKiloPass({ tier: toTier, cadence: toCadence });

      const scheduledChangeId = crypto.randomUUID();
      const metadata = {
        type: 'kilo-pass',
        kiloUserId: ctx.user.id,
        tier: toTier,
        cadence: toCadence,
        kiloPassScheduledChangeId: scheduledChangeId,
      };

      let stripeScheduleId: string | null = null;
      try {
        const schedule = await stripe.subscriptionSchedules.create({
          from_subscription: subscription.stripeSubscriptionId,
        });

        stripeScheduleId = schedule.id;
        const currentPhaseStartDate = schedule.current_phase?.start_date;
        if (typeof currentPhaseStartDate !== 'number') {
          throw new Error(
            `Stripe subscription schedule missing phases[0].start_date (schedule=${schedule.id})`
          );
        }

        const newPhase: Stripe.SubscriptionScheduleUpdateParams.Phase = {
          items: [{ price: targetPriceId, quantity: 1 }],
          start_date: effectiveAtUnix,
          metadata,
          proration_behavior: 'none',
        };

        const yearlyTierUpgrade =
          fromCadence === KiloPassCadence.Yearly &&
          toCadence === KiloPassCadence.Yearly &&
          toPrice > fromPrice;

        if (yearlyTierUpgrade) {
          newPhase.billing_cycle_anchor = 'phase_start';
        }

        const updatedSchedule = await stripe.subscriptionSchedules.update(schedule.id, {
          // We want the subscription to continue normally after the final phase starts.
          // Without this, Stripe may require the last phase to specify `duration`/`end_date`.
          end_behavior: 'release',
          phases: [
            {
              items: [{ price: currentPriceId, quantity: 1 }],
              start_date: currentPhaseStartDate,
              end_date: effectiveAtUnix,
            },
            newPhase,
          ],
        });

        const insertValues = {
          id: scheduledChangeId,
          kilo_user_id: ctx.user.id,
          stripe_subscription_id: subscription.stripeSubscriptionId,
          from_tier: fromTier,
          from_cadence: fromCadence,
          to_tier: toTier,
          to_cadence: toCadence,
          stripe_schedule_id: schedule.id,
          effective_at: effectiveAtIso,
          status: updatedSchedule.status as KiloPassScheduledChangeStatus,
          deleted_at: null,
        };

        await db.insert(kilo_pass_scheduled_changes).values(insertValues);

        await appendKiloPassAuditLog(db, {
          action: KiloPassAuditLogAction.StripeWebhookReceived,
          result: KiloPassAuditLogResult.Success,
          kiloUserId: ctx.user.id,
          stripeSubscriptionId: subscription.stripeSubscriptionId,
          payload: {
            scope: 'kilo_pass_scheduled_change',
            type: 'subscription_schedule.created',
            scheduledChangeId,
            scheduleId: schedule.id,
            scheduleStatus: updatedSchedule.status,
            fromTier,
            fromCadence,
            toTier,
            toCadence,
            effectiveAt: effectiveAtIso,
          },
        });

        return { scheduledChangeId, effectiveAt: effectiveAtIso };
      } catch (error) {
        // Best-effort cleanup: if we created a schedule but failed after that, release it.
        if (stripeScheduleId) {
          await releaseScheduledChangeForSubscription({
            dbOrTx: db,
            stripe,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            stripeScheduleIdIfMissingRow: stripeScheduleId,
            kiloUserIdIfMissingRow: ctx.user.id,
            reason: 'schedule_change_creation_failed',
          });
        }

        // If we inserted a row (should be impossible due to ordering) we would want to mark it failed.
        // Keep error visibility by rethrowing.
        throw error;
      }
    }),

  cancelScheduledChange: baseProcedure
    .output(CancelScheduledChangeOutputSchema)
    .mutation(async ({ ctx }) => {
      const subscription = await getKiloPassStateForUser(db, ctx.user.id);
      if (!subscription) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No Kilo Pass subscription found.' });
      }

      const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
        columns: { id: true, stripe_schedule_id: true },
        where: and(
          eq(kilo_pass_scheduled_changes.stripe_subscription_id, subscription.stripeSubscriptionId),
          isNull(kilo_pass_scheduled_changes.deleted_at)
        ),
      });

      if (!scheduledChange) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No pending scheduled change found.',
        });
      }

      const scheduleId = scheduledChange.stripe_schedule_id;
      await releaseScheduledChangeForSubscription({
        dbOrTx: db,
        stripe,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        stripeScheduleIdIfMissingRow: scheduleId,
        kiloUserIdIfMissingRow: ctx.user.id,
        reason: 'cancel_scheduled_change',
      });

      return { success: true };
    }),

  createCheckoutSession: baseProcedure
    .input(CreateCheckoutSessionInputSchema)
    .output(CreateCheckoutSessionOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { tier, cadence } = input;

      const existing = await getKiloPassStateForUser(db, ctx.user.id);
      if (existing && !isStripeSubscriptionEnded(existing.status)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You already have an active Kilo Pass subscription.',
        });
      }

      const stripeCustomerId = ctx.user.stripe_customer_id;
      if (!stripeCustomerId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Missing Stripe customer for user.',
        });
      }

      const priceId = getStripePriceIdForKiloPass({ tier, cadence });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        allow_promotion_codes: true,
        billing_address_collection: 'required',
        line_items: [{ price: priceId, quantity: 1 }],
        customer_update: {
          name: 'auto',
          address: 'auto',
        },
        tax_id_collection: {
          enabled: true,
          required: 'never',
        },
        success_url: `${APP_URL}/payments/kilo-pass/awarding?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/profile?kilo_pass_checkout=cancelled`,
        subscription_data: {
          metadata: {
            type: 'kilo-pass',
            kiloUserId: ctx.user.id,
            tier,
            cadence,
          },
        },
        metadata: {
          type: 'kilo-pass',
          kiloUserId: ctx.user.id,
          tier,
          cadence,
        },
      });

      return { url: typeof session.url === 'string' ? session.url : null };
    }),
});
