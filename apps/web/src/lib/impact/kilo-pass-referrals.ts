import 'server-only';

import { addMonths } from 'date-fns';
import { and, asc, count, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  IMPACT_ACTION_TRACKER_IDS,
  buildSalePayload,
  hashEmailForImpact,
  isImpactConfigured,
} from '@/lib/impact';
import { isImpactAdvocateConfigured } from '@/lib/impact/advocate';
import {
  dispatchImpactConversionReportById,
  queueImpactAdvocateRewardRedemption,
  resolveWinningAttributionTouch,
  type AdverseReferralPaymentReason,
} from '@/lib/impact/kiloclaw-referrals';
import { hashNormalizedEmailForDeletionTombstone } from '@/lib/impact/referral';
import { logImpactReferralDebug } from '@/lib/impact/debug';
import { KILO_PASS_TIER_CONFIG } from '@/lib/kilo-pass/constants';
import {
  deleted_user_email_tombstones,
  impact_advocate_participants,
  impact_attribution_touches,
  impact_conversion_reports,
  impact_referral_conversions,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  impact_referrals,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  kilocode_users,
  user_affiliate_attributions,
  type ImpactAttributionTouch,
} from '@kilocode/db/schema';
import {
  ImpactAdvocateProgramKey,
  ImpactAttributionTouchType,
  ImpactConversionReportState,
  ImpactReferralBeneficiaryRole,
  ImpactReferralDecisionOutcome,
  ImpactReferralPaymentProvider,
  ImpactReferralProduct,
  ImpactReferralRewardKind,
  ImpactReferralRewardStatus,
  ImpactReferralWinningTouchType,
  KiloPassCadence,
  KiloPassWelcomePromoEligibilityReason,
  type KiloPassTier,
} from '@kilocode/db/schema-types';

type DatabaseClient = typeof db | DrizzleTransaction;

export type KiloPassPaidConversionDisposition = {
  shouldEnqueueAffiliateSale: boolean;
  winningTouchType: 'referral' | 'affiliate' | 'none';
  conversionId: string | null;
  disqualificationReason: string | null;
};

export type KiloPassAdverseReferralPaymentSummary = {
  conversionId: string | null;
  canceledRewards: number;
  reviewRequiredRewards: number;
};

export type KiloPassReferralRewardExpirationSummary = {
  expiredRewards: number;
};

export const KILO_PASS_REFERRER_REWARD_CAP = 5;
const KILO_PASS_REFERRAL_REWARD_PERCENT = 0.5;
const SIGNUP_REFERRAL_TOUCH_CAPTURE_GRACE_MS = 10 * 60 * 1000;

function referralDisqualificationReason(reason: string): string {
  return `referral_${reason}`;
}

function getAdversePaymentReason(reason: AdverseReferralPaymentReason): string {
  return `referral_payment_${reason}`;
}

function getKiloPassReferralConfigurationState() {
  const impactPerformanceConfigured = isImpactConfigured();
  const impactAdvocateConfigured = isImpactAdvocateConfigured({
    product: ImpactReferralProduct.KiloPass,
  });

  return {
    impactPerformanceConfigured,
    impactAdvocateConfigured,
    isConfigured: impactPerformanceConfigured && impactAdvocateConfigured,
  };
}

function logKiloPassReferralConfigurationFailure(params: {
  sourcePaymentId?: string;
  conversionId?: string;
  userId?: string;
}): void {
  const configurationState = getKiloPassReferralConfigurationState();
  console.error('[kilo-pass-referrals] reward-bearing referral configuration is incomplete', {
    ...params,
    impactPerformanceConfigured: configurationState.impactPerformanceConfigured,
    impactAdvocateConfigured: configurationState.impactAdvocateConfigured,
  });
}

function buildImpactReferralId(touch: ImpactAttributionTouch): string | null {
  return touch.rs_code?.trim() || touch.opaque_tracking_value?.trim() || null;
}

async function findAcceptedUserTouches(params: {
  userId: string;
  convertedAt: Date;
  database: DatabaseClient;
}): Promise<ImpactAttributionTouch[]> {
  return await params.database
    .select()
    .from(impact_attribution_touches)
    .where(
      and(
        eq(impact_attribution_touches.product, ImpactReferralProduct.KiloPass),
        eq(impact_attribution_touches.user_id, params.userId),
        lte(impact_attribution_touches.touched_at, params.convertedAt.toISOString())
      )
    )
    .orderBy(
      asc(impact_attribution_touches.touched_at),
      asc(impact_attribution_touches.created_at)
    );
}

async function hasHistoricalImpactAffiliateAttribution(params: {
  userId: string;
  database: DatabaseClient;
}): Promise<boolean> {
  const [attribution] = await params.database
    .select({ id: user_affiliate_attributions.id })
    .from(user_affiliate_attributions)
    .where(
      and(
        eq(user_affiliate_attributions.user_id, params.userId),
        eq(user_affiliate_attributions.provider, 'impact')
      )
    )
    .limit(1);

  return Boolean(attribution);
}

async function markAffiliateTouchSaleAttributed(params: {
  database: DatabaseClient;
  affiliateTouchId: string;
  convertedAt: Date;
}): Promise<void> {
  await params.database
    .update(impact_attribution_touches)
    .set({
      sale_attributed_at: sql`COALESCE(${impact_attribution_touches.sale_attributed_at}, ${params.convertedAt.toISOString()}::timestamptz)`,
    })
    .where(eq(impact_attribution_touches.id, params.affiliateTouchId));
}

async function resolveReferrerUserIdFromReferralTouch(params: {
  referralTouch: ImpactAttributionTouch;
  database: DatabaseClient;
}): Promise<string | null> {
  const opaqueReferralIdentifier = buildImpactReferralId(params.referralTouch)?.trim();
  if (!opaqueReferralIdentifier) return null;

  const [participant] = await params.database
    .select({ userId: impact_advocate_participants.user_id })
    .from(impact_advocate_participants)
    .where(
      and(
        eq(impact_advocate_participants.program_key, ImpactAdvocateProgramKey.KiloPass),
        eq(impact_advocate_participants.opaque_referral_identifier, opaqueReferralIdentifier)
      )
    )
    .limit(1);

  return participant?.userId ?? null;
}

async function upsertReferralRelationship(params: {
  refereeUserId: string;
  referrerUserId: string | null;
  sourceTouchId: string;
  impactReferralId: string | null;
  database: DatabaseClient;
}): Promise<void> {
  await params.database
    .insert(impact_referrals)
    .values({
      product: ImpactReferralProduct.KiloPass,
      referee_user_id: params.refereeUserId,
      referrer_user_id: params.referrerUserId,
      source_touch_id: params.sourceTouchId,
      impact_referral_id: params.impactReferralId,
    })
    .onConflictDoUpdate({
      target: [impact_referrals.product, impact_referrals.referee_user_id],
      set: {
        referrer_user_id: params.referrerUserId,
        source_touch_id: params.sourceTouchId,
        impact_referral_id: params.impactReferralId,
      },
    });
}

function wasReferralTouchCapturedDuringSignup(params: {
  userCreatedAt: string;
  referralTouch: ImpactAttributionTouch;
}): boolean {
  if (!params.referralTouch.landing_path) return false;

  const touchTime = new Date(params.referralTouch.touched_at).getTime();
  const userCreatedTime = new Date(params.userCreatedAt).getTime();
  if (touchTime < userCreatedTime) return false;
  if (touchTime - userCreatedTime > SIGNUP_REFERRAL_TOUCH_CAPTURE_GRACE_MS) return false;

  try {
    const landingUrl = new URL(params.referralTouch.landing_path, 'http://localhost');
    return landingUrl.searchParams.get('signup') === 'true';
  } catch {
    return false;
  }
}

async function hasDeletedUserEmailTombstone(params: {
  normalizedEmail: string | null;
  database: DatabaseClient;
}): Promise<boolean> {
  if (!params.normalizedEmail) return false;

  const [row] = await params.database
    .select({ hash: deleted_user_email_tombstones.normalized_email_hash })
    .from(deleted_user_email_tombstones)
    .where(
      eq(
        deleted_user_email_tombstones.normalized_email_hash,
        hashNormalizedEmailForDeletionTombstone(params.normalizedEmail)
      )
    )
    .limit(1);

  return Boolean(row);
}

async function lockReferrerRewardCapacity(
  referrerUserId: string,
  database: DatabaseClient
): Promise<void> {
  await database.execute(
    sql`SELECT ${kilocode_users.id} FROM ${kilocode_users} WHERE ${kilocode_users.id} = ${referrerUserId} FOR UPDATE`
  );
}

async function getGrantedKiloPassReferrerRewardCount(
  referrerUserId: string,
  database: DatabaseClient
): Promise<number> {
  const [result] = await database
    .select({ rewardCount: count() })
    .from(impact_referral_reward_decisions)
    .where(
      and(
        eq(impact_referral_reward_decisions.product, ImpactReferralProduct.KiloPass),
        eq(impact_referral_reward_decisions.reward_kind, ImpactReferralRewardKind.KiloPassBonus),
        eq(impact_referral_reward_decisions.beneficiary_user_id, referrerUserId),
        eq(
          impact_referral_reward_decisions.beneficiary_role,
          ImpactReferralBeneficiaryRole.Referrer
        ),
        eq(impact_referral_reward_decisions.outcome, ImpactReferralDecisionOutcome.Granted)
      )
    );

  return result?.rewardCount ?? 0;
}

async function hasPriorKiloPassSubscriptionHistory(params: {
  userId: string;
  currentSubscriptionId: string;
  currentStripeInvoiceId: string;
  database: DatabaseClient;
}): Promise<boolean> {
  const [priorSubscription] = await params.database
    .select({ id: kilo_pass_subscriptions.id })
    .from(kilo_pass_subscriptions)
    .where(
      and(
        eq(kilo_pass_subscriptions.kilo_user_id, params.userId),
        ne(kilo_pass_subscriptions.id, params.currentSubscriptionId)
      )
    )
    .limit(1);
  if (priorSubscription) return true;

  const [priorIssuance] = await params.database
    .select({ id: kilo_pass_issuances.id })
    .from(kilo_pass_issuances)
    .where(
      and(
        eq(kilo_pass_issuances.kilo_pass_subscription_id, params.currentSubscriptionId),
        ne(kilo_pass_issuances.stripe_invoice_id, params.currentStripeInvoiceId)
      )
    )
    .limit(1);

  return Boolean(priorIssuance);
}

function getRewardAmountUsd(sourceTier: KiloPassTier): number {
  return (
    Math.round(
      KILO_PASS_TIER_CONFIG[sourceTier].monthlyPriceUsd * KILO_PASS_REFERRAL_REWARD_PERCENT * 100
    ) / 100
  );
}

function shouldPreserveAffiliateSale(winningTouchType: string): boolean {
  return winningTouchType === ImpactReferralWinningTouchType.Affiliate;
}

export async function expirePendingKiloPassReferralRewards(params?: {
  now?: Date;
  database?: DatabaseClient;
}): Promise<KiloPassReferralRewardExpirationSummary> {
  const now = params?.now ?? new Date();
  const database = params?.database ?? db;
  const nowIso = now.toISOString();

  const expiredRewards = await database
    .update(impact_referral_rewards)
    .set({
      status: ImpactReferralRewardStatus.Expired,
      reversed_at: nowIso,
      review_reason: 'expired_kilo_pass_referral_reward',
    })
    .where(
      and(
        eq(impact_referral_rewards.product, ImpactReferralProduct.KiloPass),
        eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloPassBonus),
        inArray(impact_referral_rewards.status, [
          ImpactReferralRewardStatus.Pending,
          ImpactReferralRewardStatus.Earned,
        ]),
        isNull(impact_referral_rewards.applied_at),
        isNull(impact_referral_rewards.consumed_kilo_pass_issuance_id),
        sql`${impact_referral_rewards.expires_at} IS NOT NULL`,
        lte(impact_referral_rewards.expires_at, nowIso)
      )
    )
    .returning({ id: impact_referral_rewards.id });

  return { expiredRewards: expiredRewards.length };
}

export async function markPersonalKiloPassReferralPaymentAdverse(params: {
  sourcePaymentId: string;
  reason: AdverseReferralPaymentReason;
  occurredAt: Date;
  paymentProvider?: ImpactReferralPaymentProvider;
}): Promise<KiloPassAdverseReferralPaymentSummary> {
  const paymentProvider = params.paymentProvider ?? ImpactReferralPaymentProvider.Stripe;
  const reviewReason = getAdversePaymentReason(params.reason);
  const occurredAt = params.occurredAt.toISOString();

  return await db.transaction(async tx => {
    const conversion = await tx.query.impact_referral_conversions.findFirst({
      where: and(
        eq(impact_referral_conversions.product, ImpactReferralProduct.KiloPass),
        eq(impact_referral_conversions.payment_provider, paymentProvider),
        eq(impact_referral_conversions.source_payment_id, params.sourcePaymentId)
      ),
      columns: { id: true },
    });

    if (!conversion) {
      return {
        conversionId: null,
        canceledRewards: 0,
        reviewRequiredRewards: 0,
      } satisfies KiloPassAdverseReferralPaymentSummary;
    }

    const canceledRewards = await tx
      .update(impact_referral_rewards)
      .set({
        status: ImpactReferralRewardStatus.Canceled,
        review_reason: reviewReason,
        reversed_at: occurredAt,
      })
      .where(
        and(
          eq(impact_referral_rewards.product, ImpactReferralProduct.KiloPass),
          eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloPassBonus),
          eq(impact_referral_rewards.conversion_id, conversion.id),
          inArray(impact_referral_rewards.status, [
            ImpactReferralRewardStatus.Pending,
            ImpactReferralRewardStatus.Earned,
          ]),
          sql`${impact_referral_rewards.applied_at} IS NULL`,
          sql`${impact_referral_rewards.consumed_kilo_pass_issuance_id} IS NULL`
        )
      )
      .returning({ id: impact_referral_rewards.id });

    const reviewRequiredRewards = await tx
      .update(impact_referral_rewards)
      .set({
        status: ImpactReferralRewardStatus.ReviewRequired,
        review_reason: reviewReason,
        reversed_at: occurredAt,
      })
      .where(
        and(
          eq(impact_referral_rewards.product, ImpactReferralProduct.KiloPass),
          eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloPassBonus),
          eq(impact_referral_rewards.conversion_id, conversion.id),
          eq(impact_referral_rewards.status, ImpactReferralRewardStatus.Applied)
        )
      )
      .returning({ id: impact_referral_rewards.id });

    return {
      conversionId: conversion.id,
      canceledRewards: canceledRewards.length,
      reviewRequiredRewards: reviewRequiredRewards.length,
    } satisfies KiloPassAdverseReferralPaymentSummary;
  });
}

export async function processPersonalKiloPassStripePaidConversion(params: {
  userId: string;
  kiloPassSubscriptionId: string;
  sourcePaymentId: string;
  orderId: string;
  amount: number;
  currencyCode: string;
  itemCategory: string;
  itemName: string;
  itemSku?: string;
  sourceTier: KiloPassTier;
  cadence: KiloPassCadence;
  welcomePromoEligibilityReason?: KiloPassWelcomePromoEligibilityReason | null;
  convertedAt: Date;
}): Promise<KiloPassPaidConversionDisposition> {
  const paymentProvider = ImpactReferralPaymentProvider.Stripe;
  const referralSaleDedupeKey = `impact-referral-sale:${ImpactReferralProduct.KiloPass}:${paymentProvider}:${params.sourcePaymentId}`;

  logImpactReferralDebug('Processing personal Kilo Pass paid conversion for Impact referrals', {
    userId: params.userId,
    sourcePaymentId: params.sourcePaymentId,
    orderId: params.orderId,
    amount: params.amount,
    currencyCode: params.currencyCode,
    itemCategory: params.itemCategory,
    cadence: params.cadence,
    sourceTier: params.sourceTier,
    welcomePromoEligibilityReason: params.welcomePromoEligibilityReason ?? null,
  });

  let impactReportId: string | null = null;
  const disposition = await db.transaction(async tx => {
    const existingConversion = await tx.query.impact_referral_conversions.findFirst({
      where: and(
        eq(impact_referral_conversions.product, ImpactReferralProduct.KiloPass),
        eq(impact_referral_conversions.payment_provider, paymentProvider),
        eq(impact_referral_conversions.source_payment_id, params.sourcePaymentId)
      ),
    });

    if (existingConversion) {
      const existingReport = await tx.query.impact_conversion_reports.findFirst({
        where: eq(impact_conversion_reports.conversion_id, existingConversion.id),
        columns: { id: true, state: true },
      });
      const reportIsRetryable =
        existingReport?.state === ImpactConversionReportState.Queued ||
        existingReport?.state === ImpactConversionReportState.Retrying;
      impactReportId =
        existingConversion.qualified &&
        existingConversion.winning_touch_type === ImpactReferralWinningTouchType.Referral &&
        reportIsRetryable
          ? (existingReport?.id ?? null)
          : null;

      return {
        shouldEnqueueAffiliateSale: shouldPreserveAffiliateSale(
          existingConversion.winning_touch_type
        ),
        winningTouchType: existingConversion.winning_touch_type,
        conversionId: existingConversion.id,
        disqualificationReason: existingConversion.disqualification_reason,
      } satisfies KiloPassPaidConversionDisposition;
    }

    const [user] = await tx
      .select({
        id: kilocode_users.id,
        createdAt: kilocode_users.created_at,
        email: kilocode_users.google_user_email,
        normalizedEmail: kilocode_users.normalized_email,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, params.userId))
      .limit(1);

    if (!user) {
      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.None,
        conversionId: null,
        disqualificationReason: 'user_missing',
      } satisfies KiloPassPaidConversionDisposition;
    }

    const touches = await findAcceptedUserTouches({
      userId: params.userId,
      convertedAt: params.convertedAt,
      database: tx,
    });
    const resolution = resolveWinningAttributionTouch({
      product: ImpactReferralProduct.KiloPass,
      touches,
      convertedAt: params.convertedAt,
    });

    logImpactReferralDebug('Resolved Kilo Pass Impact attribution touches for paid conversion', {
      userId: params.userId,
      sourcePaymentId: params.sourcePaymentId,
      touchCount: touches.length,
      affiliateTouchCount: touches.filter(
        touch => touch.touch_type === ImpactAttributionTouchType.Affiliate
      ).length,
      referralTouchCount: touches.filter(
        touch => touch.touch_type === ImpactAttributionTouchType.Referral
      ).length,
      winner: resolution.winner,
      affiliateTouchId: resolution.affiliateTouch?.id ?? null,
      referralTouchId: resolution.referralTouch?.id ?? null,
    });

    // Preserve legacy first-touch Impact affiliate attribution for Kilo Pass SALE reporting
    // when no product-scoped touch exists, per the affiliate spec. Expired scoped touches
    // still suppress this fallback so they cannot bypass the referral attribution window.
    if (
      resolution.winner === 'none' &&
      touches.length === 0 &&
      (await hasHistoricalImpactAffiliateAttribution({ userId: params.userId, database: tx }))
    ) {
      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          product: ImpactReferralProduct.KiloPass,
          referee_user_id: params.userId,
          referrer_user_id: null,
          source_touch_id: null,
          winning_touch_type: ImpactReferralWinningTouchType.Affiliate,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: referralDisqualificationReason('affiliate_won'),
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: true,
        winningTouchType: ImpactReferralWinningTouchType.Affiliate,
        conversionId: conversion?.id ?? null,
        disqualificationReason: referralDisqualificationReason('affiliate_won'),
      } satisfies KiloPassPaidConversionDisposition;
    }

    if (resolution.winner === 'none') {
      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          product: ImpactReferralProduct.KiloPass,
          referee_user_id: params.userId,
          referrer_user_id: null,
          source_touch_id: null,
          winning_touch_type: ImpactReferralWinningTouchType.None,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: referralDisqualificationReason('no_valid_attribution'),
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.None,
        conversionId: conversion?.id ?? null,
        disqualificationReason: referralDisqualificationReason('no_valid_attribution'),
      } satisfies KiloPassPaidConversionDisposition;
    }

    if (resolution.winner === 'affiliate') {
      await markAffiliateTouchSaleAttributed({
        database: tx,
        affiliateTouchId: resolution.affiliateTouch.id,
        convertedAt: params.convertedAt,
      });

      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          product: ImpactReferralProduct.KiloPass,
          referee_user_id: params.userId,
          referrer_user_id: null,
          source_touch_id: resolution.affiliateTouch.id,
          winning_touch_type: ImpactReferralWinningTouchType.Affiliate,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: referralDisqualificationReason('affiliate_won'),
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: true,
        winningTouchType: ImpactReferralWinningTouchType.Affiliate,
        conversionId: conversion?.id ?? null,
        disqualificationReason: referralDisqualificationReason('affiliate_won'),
      } satisfies KiloPassPaidConversionDisposition;
    }

    const referrerUserId = await resolveReferrerUserIdFromReferralTouch({
      referralTouch: resolution.referralTouch,
      database: tx,
    });
    await upsertReferralRelationship({
      refereeUserId: params.userId,
      referrerUserId,
      sourceTouchId: resolution.referralTouch.id,
      impactReferralId: buildImpactReferralId(resolution.referralTouch),
      database: tx,
    });

    const isYearly = params.cadence === KiloPassCadence.Yearly;
    const isFreeOrComped = params.amount <= 0;
    const hasPreviouslyClaimedPaymentFingerprint =
      params.welcomePromoEligibilityReason ===
      KiloPassWelcomePromoEligibilityReason.FingerprintPreviouslyClaimed;
    const hasPriorSubscriptionHistory = await hasPriorKiloPassSubscriptionHistory({
      userId: params.userId,
      currentSubscriptionId: params.kiloPassSubscriptionId,
      currentStripeInvoiceId: params.sourcePaymentId,
      database: tx,
    });
    const deletedUser = await hasDeletedUserEmailTombstone({
      normalizedEmail: user.normalizedEmail,
      database: tx,
    });
    const userExistedBeforeReferral =
      new Date(user.createdAt).getTime() <
        new Date(resolution.referralTouch.touched_at).getTime() &&
      !wasReferralTouchCapturedDuringSignup({
        userCreatedAt: user.createdAt,
        referralTouch: resolution.referralTouch,
      });
    const isSelfReferral = referrerUserId !== null && referrerUserId === params.userId;

    const disqualificationReason = isYearly
      ? referralDisqualificationReason('non_monthly_kilo_pass_subscription')
      : isFreeOrComped
        ? referralDisqualificationReason('fully_comped_payment')
        : hasPreviouslyClaimedPaymentFingerprint
          ? referralDisqualificationReason('payment_fingerprint_previously_claimed')
          : hasPriorSubscriptionHistory
            ? referralDisqualificationReason('prior_kilo_pass_subscription')
            : deletedUser
              ? referralDisqualificationReason('deleted_user_tombstone')
              : userExistedBeforeReferral
                ? referralDisqualificationReason('existing_user_before_touch')
                : !referrerUserId
                  ? referralDisqualificationReason('referrer_unresolved')
                  : isSelfReferral
                    ? referralDisqualificationReason('self_referral')
                    : null;

    if (disqualificationReason) {
      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          product: ImpactReferralProduct.KiloPass,
          referee_user_id: params.userId,
          referrer_user_id: referrerUserId,
          source_touch_id: resolution.referralTouch.id,
          winning_touch_type: ImpactReferralWinningTouchType.Referral,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: disqualificationReason,
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.Referral,
        conversionId: conversion?.id ?? null,
        disqualificationReason,
      } satisfies KiloPassPaidConversionDisposition;
    }

    if (!referrerUserId) {
      throw new Error('Kilo Pass referral referrer unexpectedly missing after eligibility checks');
    }

    if (!getKiloPassReferralConfigurationState().isConfigured) {
      const missingConfigReason = referralDisqualificationReason('missing_configuration');
      logKiloPassReferralConfigurationFailure({
        sourcePaymentId: params.sourcePaymentId,
        userId: params.userId,
      });

      const [conversion] = await tx
        .insert(impact_referral_conversions)
        .values({
          product: ImpactReferralProduct.KiloPass,
          referee_user_id: params.userId,
          referrer_user_id: referrerUserId,
          source_touch_id: resolution.referralTouch.id,
          winning_touch_type: ImpactReferralWinningTouchType.Referral,
          source_payment_id: params.sourcePaymentId,
          payment_provider: paymentProvider,
          qualified: false,
          disqualification_reason: missingConfigReason,
          converted_at: params.convertedAt.toISOString(),
        })
        .returning({ id: impact_referral_conversions.id });

      if (!conversion) {
        throw new Error(
          `Failed to create Kilo Pass referral conversion for ${params.sourcePaymentId}`
        );
      }

      await tx.insert(impact_referral_reward_decisions).values([
        {
          product: ImpactReferralProduct.KiloPass,
          conversion_id: conversion.id,
          beneficiary_user_id: params.userId,
          beneficiary_role: ImpactReferralBeneficiaryRole.Referee,
          outcome: ImpactReferralDecisionOutcome.Disqualified,
          reason: missingConfigReason,
          reward_kind: ImpactReferralRewardKind.KiloPassBonus,
          months_granted: 0,
          reward_percent: KILO_PASS_REFERRAL_REWARD_PERCENT,
          source_tier: params.sourceTier,
          reward_amount_usd: 0,
        },
        {
          product: ImpactReferralProduct.KiloPass,
          conversion_id: conversion.id,
          beneficiary_user_id: referrerUserId,
          beneficiary_role: ImpactReferralBeneficiaryRole.Referrer,
          outcome: ImpactReferralDecisionOutcome.Disqualified,
          reason: missingConfigReason,
          reward_kind: ImpactReferralRewardKind.KiloPassBonus,
          months_granted: 0,
          reward_percent: KILO_PASS_REFERRAL_REWARD_PERCENT,
          source_tier: params.sourceTier,
          reward_amount_usd: 0,
        },
      ]);

      const payload = buildSalePayload({
        customerId: params.userId,
        customerEmailHash: hashEmailForImpact(user.email),
        eventDate: params.convertedAt,
        orderId: params.orderId,
        amount: params.amount,
        currencyCode: params.currencyCode,
        itemCategory: params.itemCategory,
        itemName: params.itemName,
        itemSku: params.itemSku,
        trackingId: null,
      });

      await tx
        .insert(impact_conversion_reports)
        .values({
          conversion_id: conversion.id,
          dedupe_key: referralSaleDedupeKey,
          action_tracker_id: IMPACT_ACTION_TRACKER_IDS.sale,
          order_id: params.orderId,
          state: ImpactConversionReportState.Failed,
          request_payload: payload satisfies Record<string, unknown>,
          response_payload: {
            error: 'missing_reward_bearing_referral_configuration',
          } satisfies Record<string, unknown>,
        })
        .onConflictDoNothing({ target: [impact_conversion_reports.dedupe_key] });

      return {
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.Referral,
        conversionId: conversion.id,
        disqualificationReason: missingConfigReason,
      } satisfies KiloPassPaidConversionDisposition;
    }

    await lockReferrerRewardCapacity(referrerUserId, tx);
    const referrerGrantedRewardCount = await getGrantedKiloPassReferrerRewardCount(
      referrerUserId,
      tx
    );
    const referrerAtCap = referrerGrantedRewardCount >= KILO_PASS_REFERRER_REWARD_CAP;
    const rewardAmountUsd = getRewardAmountUsd(params.sourceTier);
    const earnedAt = params.convertedAt.toISOString();
    const expiresAt = addMonths(params.convertedAt, 12).toISOString();

    const [conversion] = await tx
      .insert(impact_referral_conversions)
      .values({
        product: ImpactReferralProduct.KiloPass,
        referee_user_id: params.userId,
        referrer_user_id: referrerUserId,
        source_touch_id: resolution.referralTouch.id,
        winning_touch_type: ImpactReferralWinningTouchType.Referral,
        source_payment_id: params.sourcePaymentId,
        payment_provider: paymentProvider,
        qualified: true,
        disqualification_reason: null,
        converted_at: earnedAt,
      })
      .returning({ id: impact_referral_conversions.id });

    if (!conversion) {
      throw new Error(
        `Failed to create Kilo Pass referral conversion for ${params.sourcePaymentId}`
      );
    }

    const decisions = await tx
      .insert(impact_referral_reward_decisions)
      .values([
        {
          product: ImpactReferralProduct.KiloPass,
          conversion_id: conversion.id,
          beneficiary_user_id: params.userId,
          beneficiary_role: ImpactReferralBeneficiaryRole.Referee,
          outcome: ImpactReferralDecisionOutcome.Granted,
          reason: null,
          reward_kind: ImpactReferralRewardKind.KiloPassBonus,
          months_granted: 0,
          reward_percent: KILO_PASS_REFERRAL_REWARD_PERCENT,
          source_tier: params.sourceTier,
          reward_amount_usd: rewardAmountUsd,
        },
        {
          product: ImpactReferralProduct.KiloPass,
          conversion_id: conversion.id,
          beneficiary_user_id: referrerUserId,
          beneficiary_role: ImpactReferralBeneficiaryRole.Referrer,
          outcome: referrerAtCap
            ? ImpactReferralDecisionOutcome.CapLimited
            : ImpactReferralDecisionOutcome.Granted,
          reason: referrerAtCap ? referralDisqualificationReason('referrer_cap_reached') : null,
          reward_kind: ImpactReferralRewardKind.KiloPassBonus,
          months_granted: 0,
          reward_percent: KILO_PASS_REFERRAL_REWARD_PERCENT,
          source_tier: params.sourceTier,
          reward_amount_usd: referrerAtCap ? 0 : rewardAmountUsd,
        },
      ])
      .returning({
        id: impact_referral_reward_decisions.id,
        beneficiary_user_id: impact_referral_reward_decisions.beneficiary_user_id,
        beneficiary_role: impact_referral_reward_decisions.beneficiary_role,
        outcome: impact_referral_reward_decisions.outcome,
        reward_amount_usd: impact_referral_reward_decisions.reward_amount_usd,
      });

    const grantedRewards = decisions
      .filter(decision => decision.outcome === ImpactReferralDecisionOutcome.Granted)
      .map(decision => ({
        product: ImpactReferralProduct.KiloPass,
        conversion_id: conversion.id,
        decision_id: decision.id,
        beneficiary_user_id: decision.beneficiary_user_id,
        beneficiary_role: decision.beneficiary_role,
        reward_kind: ImpactReferralRewardKind.KiloPassBonus,
        months_granted: 0,
        reward_percent: KILO_PASS_REFERRAL_REWARD_PERCENT,
        source_tier: params.sourceTier,
        reward_amount_usd: decision.reward_amount_usd,
        status: ImpactReferralRewardStatus.Pending,
        applies_to_kilo_pass_subscription_id: null,
        consumed_kilo_pass_issuance_id: null,
        consumed_kilo_pass_issuance_item_id: null,
        earned_at: earnedAt,
        expires_at: expiresAt,
      }));

    if (grantedRewards.length > 0) {
      const insertedRewards = await tx
        .insert(impact_referral_rewards)
        .values(grantedRewards)
        .returning({ id: impact_referral_rewards.id });

      for (const reward of insertedRewards) {
        await queueImpactAdvocateRewardRedemption({ rewardId: reward.id, database: tx });
      }
    }

    const payload = buildSalePayload({
      customerId: params.userId,
      customerEmailHash: hashEmailForImpact(user.email),
      eventDate: params.convertedAt,
      orderId: params.orderId,
      amount: params.amount,
      currencyCode: params.currencyCode,
      itemCategory: params.itemCategory,
      itemName: params.itemName,
      itemSku: params.itemSku,
      trackingId: null,
    });

    const [report] = await tx
      .insert(impact_conversion_reports)
      .values({
        conversion_id: conversion.id,
        dedupe_key: referralSaleDedupeKey,
        action_tracker_id: IMPACT_ACTION_TRACKER_IDS.sale,
        order_id: params.orderId,
        state: ImpactConversionReportState.Queued,
        request_payload: payload satisfies Record<string, unknown>,
      })
      .onConflictDoNothing({ target: [impact_conversion_reports.dedupe_key] })
      .returning({ id: impact_conversion_reports.id });

    const existingReport =
      report ??
      (await tx.query.impact_conversion_reports.findFirst({
        where: eq(impact_conversion_reports.dedupe_key, referralSaleDedupeKey),
        columns: { id: true },
      }));
    impactReportId = existingReport?.id ?? null;

    return {
      shouldEnqueueAffiliateSale: false,
      winningTouchType: ImpactReferralWinningTouchType.Referral,
      conversionId: conversion.id,
      disqualificationReason: null,
    } satisfies KiloPassPaidConversionDisposition;
  });

  logImpactReferralDebug('Processed personal Kilo Pass paid conversion for Impact referrals', {
    userId: params.userId,
    sourcePaymentId: params.sourcePaymentId,
    shouldEnqueueAffiliateSale: disposition.shouldEnqueueAffiliateSale,
    winningTouchType: disposition.winningTouchType,
    conversionId: disposition.conversionId,
    disqualificationReason: disposition.disqualificationReason,
    impactReportId,
  });

  if (impactReportId) {
    await dispatchImpactConversionReportById(impactReportId);
  }

  return disposition;
}
