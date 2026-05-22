import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
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

const ReferralInvestigationInputSchema = z.object({
  search: z.string().trim().min(1),
});

const NullableString = z.string().nullable();

const ReferralInvestigationOutputSchema = z.object({
  referrer: z.object({
    id: z.string(),
    email: NullableString,
    name: NullableString,
  }),
  referrals: z.array(
    z.object({
      referral: z.object({
        id: z.string().uuid(),
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
          beneficiaryUserId: z.string(),
          beneficiaryRole: z.string(),
          outcome: z.string(),
          reason: NullableString,
          monthsGranted: z.number(),
          createdAt: z.string(),
        })
      ),
      rewards: z.array(
        z.object({
          id: z.string().uuid(),
          beneficiaryUserId: z.string(),
          beneficiaryRole: z.string(),
          status: z.string(),
          monthsGranted: z.number(),
          earnedAt: z.string(),
          appliedAt: NullableString,
          expiresAt: NullableString,
          reviewReason: NullableString,
        })
      ),
      rewardApplications: z.array(
        z.object({
          id: z.string().uuid(),
          beneficiaryUserId: z.string(),
          subscriptionId: z.string().uuid().nullable(),
          previousRenewalBoundary: z.string(),
          newRenewalBoundary: z.string(),
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

async function investigateReferrer(search: string): Promise<ReferralInvestigationOutput> {
  const referrer = await findReferrer(search);
  if (!referrer) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Referrer not found.' });
  }

  const referralRows = await db
    .select({
      referralId: impact_referrals.id,
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
      and(
        eq(impact_referrals.product, ImpactReferralProduct.KiloClaw),
        eq(impact_referrals.referrer_user_id, referrer.id)
      )
    )
    .orderBy(desc(impact_referrals.created_at));

  const conversions = await db
    .select({
      id: impact_referral_conversions.id,
      refereeUserId: impact_referral_conversions.referee_user_id,
      winningTouchType: impact_referral_conversions.winning_touch_type,
      sourcePaymentId: impact_referral_conversions.source_payment_id,
      qualified: impact_referral_conversions.qualified,
      disqualificationReason: impact_referral_conversions.disqualification_reason,
      convertedAt: impact_referral_conversions.converted_at,
    })
    .from(impact_referral_conversions)
    .where(
      and(
        eq(impact_referral_conversions.product, ImpactReferralProduct.KiloClaw),
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
          beneficiaryUserId: impact_referral_reward_decisions.beneficiary_user_id,
          beneficiaryRole: impact_referral_reward_decisions.beneficiary_role,
          outcome: impact_referral_reward_decisions.outcome,
          reason: impact_referral_reward_decisions.reason,
          monthsGranted: impact_referral_reward_decisions.months_granted,
          createdAt: impact_referral_reward_decisions.created_at,
        })
        .from(impact_referral_reward_decisions)
        .where(
          and(
            eq(impact_referral_reward_decisions.product, ImpactReferralProduct.KiloClaw),
            eq(
              impact_referral_reward_decisions.reward_kind,
              ImpactReferralRewardKind.KiloClawFreeMonth
            ),
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
          beneficiaryUserId: impact_referral_rewards.beneficiary_user_id,
          beneficiaryRole: impact_referral_rewards.beneficiary_role,
          status: impact_referral_rewards.status,
          monthsGranted: impact_referral_rewards.months_granted,
          earnedAt: impact_referral_rewards.earned_at,
          appliedAt: impact_referral_rewards.applied_at,
          expiresAt: impact_referral_rewards.expires_at,
          reviewReason: impact_referral_rewards.review_reason,
        })
        .from(impact_referral_rewards)
        .where(
          and(
            eq(impact_referral_rewards.product, ImpactReferralProduct.KiloClaw),
            eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloClawFreeMonth),
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
          beneficiaryUserId: impact_referral_reward_applications.beneficiary_user_id,
          subscriptionId: impact_referral_reward_applications.subscription_id,
          previousRenewalBoundary: impact_referral_reward_applications.previous_renewal_boundary,
          newRenewalBoundary: impact_referral_reward_applications.new_renewal_boundary,
          appliedAt: impact_referral_reward_applications.applied_at,
        })
        .from(impact_referral_reward_applications)
        .innerJoin(
          impact_referral_rewards,
          eq(impact_referral_rewards.id, impact_referral_reward_applications.reward_id)
        )
        .where(
          and(
            eq(impact_referral_rewards.product, ImpactReferralProduct.KiloClaw),
            eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloClawFreeMonth),
            eq(impact_referral_reward_applications.product, ImpactReferralProduct.KiloClaw),
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
            eq(impact_referral_rewards.product, ImpactReferralProduct.KiloClaw),
            eq(impact_referral_rewards.reward_kind, ImpactReferralRewardKind.KiloClawFreeMonth),
            inArray(impact_referral_rewards.conversion_id, conversionIds)
          )
        )
        .orderBy(desc(impact_advocate_reward_redemptions.created_at))
    : [];

  return {
    referrer: {
      id: referrer.id,
      email: referrer.email,
      name: referrer.name,
    },
    referrals: referralRows.map(referral => {
      const conversion = conversions.find(row => row.refereeUserId === referral.refereeId) ?? null;
      const conversionId = conversion?.id ?? null;

      return {
        referral: {
          id: referral.referralId,
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
              beneficiaryUserId: decision.beneficiaryUserId,
              beneficiaryRole: decision.beneficiaryRole,
              outcome: decision.outcome,
              reason: decision.reason,
              monthsGranted: decision.monthsGranted,
              createdAt: normalizeTimestamp(decision.createdAt) ?? decision.createdAt,
            }))
          : [],
        rewards: conversionId
          ? listByConversionId(rewards, conversionId).map(reward => ({
              id: reward.id,
              beneficiaryUserId: reward.beneficiaryUserId,
              beneficiaryRole: reward.beneficiaryRole,
              status: reward.status,
              monthsGranted: reward.monthsGranted,
              earnedAt: normalizeTimestamp(reward.earnedAt) ?? reward.earnedAt,
              appliedAt: normalizeTimestamp(reward.appliedAt),
              expiresAt: normalizeTimestamp(reward.expiresAt),
              reviewReason: reward.reviewReason,
            }))
          : [],
        rewardApplications: conversionId
          ? listByConversionId(rewardApplications, conversionId).map(application => ({
              id: application.id,
              beneficiaryUserId: application.beneficiaryUserId,
              subscriptionId: application.subscriptionId,
              previousRenewalBoundary:
                normalizeTimestamp(application.previousRenewalBoundary) ??
                application.previousRenewalBoundary,
              newRenewalBoundary:
                normalizeTimestamp(application.newRenewalBoundary) ??
                application.newRenewalBoundary,
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
      return await investigateReferrer(input.search);
    }),
});
