import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  impact_advocate_participants,
  impact_advocate_registration_attempts,
  impact_advocate_reward_redemptions,
  impact_conversion_reports,
  impact_attribution_touches,
  impact_referral_conversions,
  impact_referral_reward_applications,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  impact_referrals,
  kilocode_users,
} from '@kilocode/db/schema';
import { ImpactReferralProduct, ImpactReferralRewardKind } from '@kilocode/db/schema-types';

const ReferralProductSchema = z.enum([
  ImpactReferralProduct.KiloClaw,
  ImpactReferralProduct.KiloPass,
]);

const ReferralInvestigationInputSchema = z.object({
  search: z.string().trim().min(1),
  product: ReferralProductSchema.default(ImpactReferralProduct.KiloClaw),
});

const NullableString = z.string().nullable();

const ReferralInvestigationOutputSchema = z.object({
  product: ReferralProductSchema,
  productLabel: z.string(),
  referrer: z.object({
    id: z.string(),
    email: NullableString,
    name: NullableString,
  }),
  participantRegistrations: z.array(
    z.object({
      id: z.string().uuid(),
      programKey: ReferralProductSchema,
      registrationState: z.string(),
      registeredAt: NullableString,
      lastRegistrationAttemptAt: NullableString,
      lastErrorCode: NullableString,
      lastErrorMessage: NullableString,
      latestAttempt: z
        .object({
          id: z.string().uuid(),
          deliveryState: z.string(),
          responseStatusCode: z.number().nullable(),
          nextRetryAt: NullableString,
          createdAt: z.string(),
        })
        .nullable(),
    })
  ),
  referrals: z.array(
    z.object({
      referral: z.object({
        id: z.string().uuid(),
        product: ReferralProductSchema,
        productLabel: z.string(),
        impactReferralId: NullableString,
        createdAt: z.string(),
      }),
      referee: z.object({
        id: z.string(),
        email: NullableString,
        name: NullableString,
      }),
      sourceTouch: z
        .object({
          id: z.string().uuid(),
          provider: NullableString,
          touchType: NullableString,
          landingPath: NullableString,
          rsCode: NullableString,
          imRef: NullableString,
          touchedAt: NullableString,
          expiresAt: NullableString,
        })
        .nullable(),
      conversion: z
        .object({
          id: z.string().uuid(),
          product: ReferralProductSchema,
          paymentProvider: z.string(),
          winningTouchType: z.string(),
          sourcePaymentId: z.string(),
          qualified: z.boolean(),
          disqualificationReason: NullableString,
          convertedAt: z.string(),
        })
        .nullable(),
      rewardDecisions: z.array(
        z.object({
          id: z.string().uuid(),
          product: ReferralProductSchema,
          beneficiaryUserId: z.string(),
          beneficiaryRole: z.string(),
          outcome: z.string(),
          reason: NullableString,
          rewardKind: z.string(),
          monthsGranted: z.number(),
          rewardPercent: z.number().nullable(),
          sourceTier: NullableString,
          rewardAmountUsd: z.number().nullable(),
          createdAt: z.string(),
        })
      ),
      rewards: z.array(
        z.object({
          id: z.string().uuid(),
          product: ReferralProductSchema,
          beneficiaryUserId: z.string(),
          beneficiaryRole: z.string(),
          rewardKind: z.string(),
          status: z.string(),
          monthsGranted: z.number(),
          rewardPercent: z.number().nullable(),
          sourceTier: NullableString,
          rewardAmountUsd: z.number().nullable(),
          earnedAt: z.string(),
          appliedAt: NullableString,
          expiresAt: NullableString,
          reviewReason: NullableString,
          appliesToKiloPassSubscriptionId: z.string().uuid().nullable(),
          consumedKiloPassIssuanceId: z.string().uuid().nullable(),
          consumedKiloPassIssuanceItemId: z.string().uuid().nullable(),
        })
      ),
      rewardApplications: z.array(
        z.object({
          id: z.string().uuid(),
          product: ReferralProductSchema,
          beneficiaryUserId: z.string(),
          subscriptionId: z.string().uuid().nullable(),
          previousRenewalBoundary: z.string(),
          newRenewalBoundary: z.string(),
          localOperationId: NullableString,
          stripeOperationId: NullableString,
          appliedAt: z.string(),
        })
      ),
      impactReports: z.array(
        z.object({
          id: z.string().uuid(),
          state: z.string(),
          actionTrackerId: z.number(),
          orderId: z.string(),
          deliveredAt: NullableString,
          nextRetryAt: NullableString,
          responseStatusCode: z.number().nullable(),
        })
      ),
      impactRewardRedemptions: z.array(
        z.object({
          id: z.string().uuid(),
          rewardId: z.string().uuid(),
          beneficiaryUserId: z.string(),
          state: z.string(),
          impactRewardId: NullableString,
          redeemedAt: NullableString,
          nextRetryAt: NullableString,
          responseStatusCode: z.number().nullable(),
        })
      ),
    })
  ),
});

type ReferralInvestigationOutput = z.infer<typeof ReferralInvestigationOutputSchema>;

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function listByConversionId<T extends { conversionId: string | null }>(
  rows: T[],
  conversionId: string
): T[] {
  return rows.filter(row => row.conversionId === conversionId);
}

function getProductLabel(product: ImpactReferralProduct): string {
  return product === ImpactReferralProduct.KiloPass ? 'Kilo Pass' : 'KiloClaw';
}

function getRewardKindForProduct(product: ImpactReferralProduct): ImpactReferralRewardKind {
  return product === ImpactReferralProduct.KiloPass
    ? ImpactReferralRewardKind.KiloPassBonus
    : ImpactReferralRewardKind.KiloClawFreeMonth;
}

function latestAttemptForParticipant<
  T extends { participantId: string; createdAt: string | null | undefined },
>(attempts: T[], participantId: string): T | null {
  return attempts.find(attempt => attempt.participantId === participantId) ?? null;
}

async function findReferrer(search: string) {
  const normalizedSearch = search.trim().toLowerCase();
  const [referrer] = await db
    .select({
      id: kilocode_users.id,
      email: kilocode_users.google_user_email,
      normalizedEmail: kilocode_users.normalized_email,
      name: kilocode_users.google_user_name,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.id, search),
        eq(kilocode_users.google_user_email, search),
        eq(kilocode_users.normalized_email, normalizedSearch)
      )
    )
    .limit(1);

  return referrer ?? null;
}

async function investigateReferrer(
  search: string,
  product: ImpactReferralProduct
): Promise<ReferralInvestigationOutput> {
  const referrer = await findReferrer(search);
  if (!referrer) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Referrer not found.' });
  }

  const productLabel = getProductLabel(product);
  const rewardKind = getRewardKindForProduct(product);

  const participantRows = await db
    .select({
      id: impact_advocate_participants.id,
      programKey: impact_advocate_participants.program_key,
      registrationState: impact_advocate_participants.registration_state,
      registeredAt: impact_advocate_participants.registered_at,
      lastRegistrationAttemptAt: impact_advocate_participants.last_registration_attempt_at,
      lastErrorCode: impact_advocate_participants.last_error_code,
      lastErrorMessage: impact_advocate_participants.last_error_message,
    })
    .from(impact_advocate_participants)
    .where(
      and(
        eq(impact_advocate_participants.program_key, product),
        eq(impact_advocate_participants.user_id, referrer.id)
      )
    )
    .orderBy(desc(impact_advocate_participants.created_at));

  const participantIds = participantRows.map(participant => participant.id);
  const participantAttempts = participantIds.length
    ? await db
        .select({
          participantId: impact_advocate_registration_attempts.participant_id,
          id: impact_advocate_registration_attempts.id,
          deliveryState: impact_advocate_registration_attempts.delivery_state,
          responseStatusCode: impact_advocate_registration_attempts.response_status_code,
          nextRetryAt: impact_advocate_registration_attempts.next_retry_at,
          createdAt: impact_advocate_registration_attempts.created_at,
        })
        .from(impact_advocate_registration_attempts)
        .where(
          and(
            eq(impact_advocate_registration_attempts.program_key, product),
            inArray(impact_advocate_registration_attempts.participant_id, participantIds)
          )
        )
        .orderBy(desc(impact_advocate_registration_attempts.created_at))
    : [];

  const referralRows = await db
    .select({
      referralId: impact_referrals.id,
      referralProduct: impact_referrals.product,
      impactReferralId: impact_referrals.impact_referral_id,
      referralCreatedAt: impact_referrals.created_at,
      refereeId: kilocode_users.id,
      refereeEmail: kilocode_users.google_user_email,
      refereeName: kilocode_users.google_user_name,
      touchId: impact_attribution_touches.id,
      touchProvider: impact_attribution_touches.provider,
      touchType: impact_attribution_touches.touch_type,
      landingPath: impact_attribution_touches.landing_path,
      rsCode: impact_attribution_touches.rs_code,
      imRef: impact_attribution_touches.im_ref,
      touchedAt: impact_attribution_touches.touched_at,
      expiresAt: impact_attribution_touches.expires_at,
    })
    .from(impact_referrals)
    .innerJoin(kilocode_users, eq(kilocode_users.id, impact_referrals.referee_user_id))
    .leftJoin(
      impact_attribution_touches,
      eq(impact_attribution_touches.id, impact_referrals.source_touch_id)
    )
    .where(
      and(eq(impact_referrals.product, product), eq(impact_referrals.referrer_user_id, referrer.id))
    )
    .orderBy(desc(impact_referrals.created_at));

  const conversions = await db
    .select({
      id: impact_referral_conversions.id,
      product: impact_referral_conversions.product,
      refereeUserId: impact_referral_conversions.referee_user_id,
      paymentProvider: impact_referral_conversions.payment_provider,
      winningTouchType: impact_referral_conversions.winning_touch_type,
      sourcePaymentId: impact_referral_conversions.source_payment_id,
      qualified: impact_referral_conversions.qualified,
      disqualificationReason: impact_referral_conversions.disqualification_reason,
      convertedAt: impact_referral_conversions.converted_at,
    })
    .from(impact_referral_conversions)
    .where(
      and(
        eq(impact_referral_conversions.product, product),
        eq(impact_referral_conversions.referrer_user_id, referrer.id)
      )
    )
    .orderBy(desc(impact_referral_conversions.converted_at));

  const conversionIds = conversions.map(conversion => conversion.id);
  const rewardDecisions = conversionIds.length
    ? await db
        .select({
          conversionId: impact_referral_reward_decisions.conversion_id,
          id: impact_referral_reward_decisions.id,
          product: impact_referral_reward_decisions.product,
          beneficiaryUserId: impact_referral_reward_decisions.beneficiary_user_id,
          beneficiaryRole: impact_referral_reward_decisions.beneficiary_role,
          outcome: impact_referral_reward_decisions.outcome,
          reason: impact_referral_reward_decisions.reason,
          rewardKind: impact_referral_reward_decisions.reward_kind,
          monthsGranted: impact_referral_reward_decisions.months_granted,
          rewardPercent: impact_referral_reward_decisions.reward_percent,
          sourceTier: impact_referral_reward_decisions.source_tier,
          rewardAmountUsd: impact_referral_reward_decisions.reward_amount_usd,
          createdAt: impact_referral_reward_decisions.created_at,
        })
        .from(impact_referral_reward_decisions)
        .where(
          and(
            eq(impact_referral_reward_decisions.product, product),
            eq(impact_referral_reward_decisions.reward_kind, rewardKind),
            inArray(impact_referral_reward_decisions.conversion_id, conversionIds)
          )
        )
        .orderBy(desc(impact_referral_reward_decisions.created_at))
    : [];
  const rewards = conversionIds.length
    ? await db
        .select({
          conversionId: impact_referral_rewards.conversion_id,
          id: impact_referral_rewards.id,
          product: impact_referral_rewards.product,
          beneficiaryUserId: impact_referral_rewards.beneficiary_user_id,
          beneficiaryRole: impact_referral_rewards.beneficiary_role,
          rewardKind: impact_referral_rewards.reward_kind,
          status: impact_referral_rewards.status,
          monthsGranted: impact_referral_rewards.months_granted,
          rewardPercent: impact_referral_rewards.reward_percent,
          sourceTier: impact_referral_rewards.source_tier,
          rewardAmountUsd: impact_referral_rewards.reward_amount_usd,
          earnedAt: impact_referral_rewards.earned_at,
          appliedAt: impact_referral_rewards.applied_at,
          expiresAt: impact_referral_rewards.expires_at,
          reviewReason: impact_referral_rewards.review_reason,
          appliesToKiloPassSubscriptionId:
            impact_referral_rewards.applies_to_kilo_pass_subscription_id,
          consumedKiloPassIssuanceId: impact_referral_rewards.consumed_kilo_pass_issuance_id,
          consumedKiloPassIssuanceItemId:
            impact_referral_rewards.consumed_kilo_pass_issuance_item_id,
        })
        .from(impact_referral_rewards)
        .where(
          and(
            eq(impact_referral_rewards.product, product),
            eq(impact_referral_rewards.reward_kind, rewardKind),
            inArray(impact_referral_rewards.conversion_id, conversionIds)
          )
        )
        .orderBy(desc(impact_referral_rewards.created_at))
    : [];
  const rewardApplications = conversionIds.length
    ? await db
        .select({
          conversionId: impact_referral_rewards.conversion_id,
          id: impact_referral_reward_applications.id,
          product: impact_referral_reward_applications.product,
          beneficiaryUserId: impact_referral_reward_applications.beneficiary_user_id,
          subscriptionId: impact_referral_reward_applications.subscription_id,
          previousRenewalBoundary: impact_referral_reward_applications.previous_renewal_boundary,
          newRenewalBoundary: impact_referral_reward_applications.new_renewal_boundary,
          localOperationId: impact_referral_reward_applications.local_operation_id,
          stripeOperationId: impact_referral_reward_applications.stripe_operation_id,
          appliedAt: impact_referral_reward_applications.applied_at,
        })
        .from(impact_referral_reward_applications)
        .innerJoin(
          impact_referral_rewards,
          eq(impact_referral_rewards.id, impact_referral_reward_applications.reward_id)
        )
        .where(
          and(
            eq(impact_referral_rewards.product, product),
            eq(impact_referral_rewards.reward_kind, rewardKind),
            eq(impact_referral_reward_applications.product, product),
            inArray(impact_referral_rewards.conversion_id, conversionIds)
          )
        )
        .orderBy(desc(impact_referral_reward_applications.applied_at))
    : [];
  const impactReports = conversionIds.length
    ? await db
        .select({
          conversionId: impact_conversion_reports.conversion_id,
          id: impact_conversion_reports.id,
          state: impact_conversion_reports.state,
          actionTrackerId: impact_conversion_reports.action_tracker_id,
          orderId: impact_conversion_reports.order_id,
          deliveredAt: impact_conversion_reports.delivered_at,
          nextRetryAt: impact_conversion_reports.next_retry_at,
          responseStatusCode: impact_conversion_reports.response_status_code,
        })
        .from(impact_conversion_reports)
        .where(inArray(impact_conversion_reports.conversion_id, conversionIds))
        .orderBy(desc(impact_conversion_reports.created_at))
    : [];
  const impactRewardRedemptions = conversionIds.length
    ? await db
        .select({
          conversionId: impact_referral_rewards.conversion_id,
          id: impact_advocate_reward_redemptions.id,
          rewardId: impact_advocate_reward_redemptions.reward_id,
          beneficiaryUserId: impact_advocate_reward_redemptions.beneficiary_user_id,
          state: impact_advocate_reward_redemptions.state,
          impactRewardId: impact_advocate_reward_redemptions.impact_reward_id,
          redeemedAt: impact_advocate_reward_redemptions.redeemed_at,
          nextRetryAt: impact_advocate_reward_redemptions.next_retry_at,
          responseStatusCode: impact_advocate_reward_redemptions.response_status_code,
        })
        .from(impact_advocate_reward_redemptions)
        .innerJoin(
          impact_referral_rewards,
          eq(impact_referral_rewards.id, impact_advocate_reward_redemptions.reward_id)
        )
        .where(
          and(
            eq(impact_referral_rewards.product, product),
            eq(impact_referral_rewards.reward_kind, rewardKind),
            inArray(impact_referral_rewards.conversion_id, conversionIds)
          )
        )
        .orderBy(desc(impact_advocate_reward_redemptions.created_at))
    : [];

  return {
    product,
    productLabel,
    referrer: {
      id: referrer.id,
      email: referrer.email,
      name: referrer.name,
    },
    participantRegistrations: participantRows.map(participant => {
      const latestAttempt = latestAttemptForParticipant(participantAttempts, participant.id);
      return {
        id: participant.id,
        programKey: participant.programKey,
        registrationState: participant.registrationState,
        registeredAt: normalizeTimestamp(participant.registeredAt),
        lastRegistrationAttemptAt: normalizeTimestamp(participant.lastRegistrationAttemptAt),
        lastErrorCode: participant.lastErrorCode,
        lastErrorMessage: participant.lastErrorMessage,
        latestAttempt: latestAttempt
          ? {
              id: latestAttempt.id,
              deliveryState: latestAttempt.deliveryState,
              responseStatusCode: latestAttempt.responseStatusCode,
              nextRetryAt: normalizeTimestamp(latestAttempt.nextRetryAt),
              createdAt: normalizeTimestamp(latestAttempt.createdAt) ?? latestAttempt.createdAt,
            }
          : null,
      };
    }),
    referrals: referralRows.map(referral => {
      const conversion = conversions.find(row => row.refereeUserId === referral.refereeId) ?? null;
      const conversionId = conversion?.id ?? null;

      return {
        referral: {
          id: referral.referralId,
          product: referral.referralProduct,
          productLabel: getProductLabel(referral.referralProduct),
          impactReferralId: referral.impactReferralId,
          createdAt: normalizeTimestamp(referral.referralCreatedAt) ?? referral.referralCreatedAt,
        },
        referee: {
          id: referral.refereeId,
          email: referral.refereeEmail,
          name: referral.refereeName,
        },
        sourceTouch: referral.touchId
          ? {
              id: referral.touchId,
              provider: referral.touchProvider,
              touchType: referral.touchType,
              landingPath: referral.landingPath,
              rsCode: referral.rsCode,
              imRef: referral.imRef,
              touchedAt: normalizeTimestamp(referral.touchedAt),
              expiresAt: normalizeTimestamp(referral.expiresAt),
            }
          : null,
        conversion: conversion
          ? {
              id: conversion.id,
              product: conversion.product,
              paymentProvider: conversion.paymentProvider,
              winningTouchType: conversion.winningTouchType,
              sourcePaymentId: conversion.sourcePaymentId,
              qualified: conversion.qualified,
              disqualificationReason: conversion.disqualificationReason,
              convertedAt: normalizeTimestamp(conversion.convertedAt) ?? conversion.convertedAt,
            }
          : null,
        rewardDecisions: conversionId
          ? listByConversionId(rewardDecisions, conversionId).map(decision => ({
              id: decision.id,
              product: decision.product,
              beneficiaryUserId: decision.beneficiaryUserId,
              beneficiaryRole: decision.beneficiaryRole,
              outcome: decision.outcome,
              reason: decision.reason,
              rewardKind: decision.rewardKind,
              monthsGranted: decision.monthsGranted,
              rewardPercent: decision.rewardPercent,
              sourceTier: decision.sourceTier,
              rewardAmountUsd: decision.rewardAmountUsd,
              createdAt: normalizeTimestamp(decision.createdAt) ?? decision.createdAt,
            }))
          : [],
        rewards: conversionId
          ? listByConversionId(rewards, conversionId).map(reward => ({
              id: reward.id,
              product: reward.product,
              beneficiaryUserId: reward.beneficiaryUserId,
              beneficiaryRole: reward.beneficiaryRole,
              rewardKind: reward.rewardKind,
              status: reward.status,
              monthsGranted: reward.monthsGranted,
              rewardPercent: reward.rewardPercent,
              sourceTier: reward.sourceTier,
              rewardAmountUsd: reward.rewardAmountUsd,
              earnedAt: normalizeTimestamp(reward.earnedAt) ?? reward.earnedAt,
              appliedAt: normalizeTimestamp(reward.appliedAt),
              expiresAt: normalizeTimestamp(reward.expiresAt),
              reviewReason: reward.reviewReason,
              appliesToKiloPassSubscriptionId: reward.appliesToKiloPassSubscriptionId,
              consumedKiloPassIssuanceId: reward.consumedKiloPassIssuanceId,
              consumedKiloPassIssuanceItemId: reward.consumedKiloPassIssuanceItemId,
            }))
          : [],
        rewardApplications: conversionId
          ? listByConversionId(rewardApplications, conversionId).map(application => ({
              id: application.id,
              product: application.product,
              beneficiaryUserId: application.beneficiaryUserId,
              subscriptionId: application.subscriptionId,
              previousRenewalBoundary:
                normalizeTimestamp(application.previousRenewalBoundary) ??
                application.previousRenewalBoundary,
              newRenewalBoundary:
                normalizeTimestamp(application.newRenewalBoundary) ??
                application.newRenewalBoundary,
              localOperationId: application.localOperationId,
              stripeOperationId: application.stripeOperationId,
              appliedAt: normalizeTimestamp(application.appliedAt) ?? application.appliedAt,
            }))
          : [],
        impactReports: conversionId
          ? listByConversionId(impactReports, conversionId).map(report => ({
              id: report.id,
              state: report.state,
              actionTrackerId: report.actionTrackerId,
              orderId: report.orderId,
              deliveredAt: normalizeTimestamp(report.deliveredAt),
              nextRetryAt: normalizeTimestamp(report.nextRetryAt),
              responseStatusCode: report.responseStatusCode,
            }))
          : [],
        impactRewardRedemptions: conversionId
          ? listByConversionId(impactRewardRedemptions, conversionId).map(redemption => ({
              id: redemption.id,
              rewardId: redemption.rewardId,
              beneficiaryUserId: redemption.beneficiaryUserId,
              state: redemption.state,
              impactRewardId: redemption.impactRewardId,
              redeemedAt: normalizeTimestamp(redemption.redeemedAt),
              nextRetryAt: normalizeTimestamp(redemption.nextRetryAt),
              responseStatusCode: redemption.responseStatusCode,
            }))
          : [],
      };
    }),
  };
}

export const adminKiloclawReferralsRouter = createTRPCRouter({
  investigateReferrer: adminProcedure
    .input(ReferralInvestigationInputSchema)
    .output(ReferralInvestigationOutputSchema)
    .query(async ({ input }) => {
      return await investigateReferrer(input.search, input.product);
    }),
});
