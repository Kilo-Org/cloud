import {
  credit_transactions,
  impact_conversion_reports,
  kiloclaw_attribution_touches,
  kiloclaw_referral_conversions,
  kiloclaw_referral_reward_applications,
  kiloclaw_referral_reward_decisions,
  kiloclaw_referral_rewards,
  kiloclaw_referrals,
} from '@kilocode/db/schema';
import {
  ImpactConversionReportState,
  ImpactAttributionTouchProvider,
  ImpactAttributionTouchType,
  KiloClawReferralBeneficiaryRole,
  KiloClawReferralDecisionOutcome,
  KiloClawReferralRewardStatus,
  KiloClawReferralWinningTouchType,
} from '@kilocode/db/schema-types';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';
import {
  assertUserCount,
  cleanupKiloClawReferralSeedScenario,
  insertAppliedRewardChangeLog,
  insertImpactAdvocateParticipant,
  insertPersonalSubscription,
  insertSeedUsers,
  seedEmail,
  seedLabelForScenario,
  seedOpaqueReferralIdentifier,
  seedOrderId,
  seedSourcePaymentId,
  seedUserId,
} from '../lib/kiloclaw-referrals';

const SCENARIO = 'referrals-happy-path';
const SEED_SCOPE = `kiloclaw/${SCENARIO}`;

const referrerUserId = seedUserId(SCENARIO, 'referrer');
const refereeUserId = seedUserId(SCENARIO, 'referee');
const userIds = [referrerUserId, refereeUserId];
const referrerEmail = seedEmail(SCENARIO, 'referrer');
const refereeEmail = seedEmail(SCENARIO, 'referee');
const opaqueReferralIdentifier = seedOpaqueReferralIdentifier(SCENARIO, 'primary');
const sourcePaymentId = seedSourcePaymentId(SCENARIO, 'period-1');
const orderId = seedOrderId(SCENARIO, 'period-1');
const touchedAtAffiliate = '2026-04-10T12:00:00.000Z';
const touchedAtReferral = '2026-04-11T09:00:00.000Z';
const convertedAt = '2026-04-15T16:30:00.000Z';
const previousRenewalBoundary = '2026-05-01T00:00:00.000Z';
const newRenewalBoundary = '2026-06-01T00:00:00.000Z';

export async function run(): Promise<SeedResult> {
  const db = getSeedDb();

  console.log(`[${SEED_SCOPE}] Resetting existing seed data`);
  await cleanupKiloClawReferralSeedScenario({
    scenario: SCENARIO,
    userIds,
  });

  console.log(`[${SEED_SCOPE}] Inserting referrer and referee users`);
  await insertSeedUsers([
    {
      id: referrerUserId,
      email: referrerEmail,
      name: 'Seed Referrals Happy Referrer',
    },
    {
      id: refereeUserId,
      email: refereeEmail,
      name: 'Seed Referrals Happy Referee',
    },
  ]);
  await assertUserCount({ userIds, expectedCount: 2 });

  console.log(`[${SEED_SCOPE}] Inserting active personal subscriptions with applied reward state`);
  const { subscription: referrerSubscription } = await insertPersonalSubscription({
    userId: referrerUserId,
    sandboxId: `sandbox-${referrerUserId}`,
    name: 'Seed Happy Path Referrer',
    plan: 'standard',
    status: 'active',
    paymentSource: 'credits',
    currentPeriodStart: '2026-04-01T00:00:00.000Z',
    currentPeriodEnd: newRenewalBoundary,
    creditRenewalAt: newRenewalBoundary,
  });
  const { subscription: refereeSubscription } = await insertPersonalSubscription({
    userId: refereeUserId,
    sandboxId: `sandbox-${refereeUserId}`,
    name: 'Seed Happy Path Referee',
    plan: 'standard',
    status: 'active',
    paymentSource: 'credits',
    currentPeriodStart: '2026-04-01T00:00:00.000Z',
    currentPeriodEnd: newRenewalBoundary,
    creditRenewalAt: newRenewalBoundary,
  });

  console.log(`[${SEED_SCOPE}] Inserting registered Advocate participant for the referrer`);
  await insertImpactAdvocateParticipant({
    userId: referrerUserId,
    email: referrerEmail,
    opaqueReferralIdentifier,
    registeredAt: '2026-04-01T12:00:00.000Z',
  });

  console.log(`[${SEED_SCOPE}] Inserting affiliate and referral touches for the referee`);
  const [affiliateTouch] = await db
    .insert(kiloclaw_attribution_touches)
    .values({
      dedupe_key: `${seedLabelForScenario(SCENARIO)}:touch:affiliate`,
      user_id: refereeUserId,
      touch_type: ImpactAttributionTouchType.Affiliate,
      provider: ImpactAttributionTouchProvider.ImpactPerformance,
      opaque_tracking_value: `${seedLabelForScenario(SCENARIO)}:im-ref`,
      tracking_value_length: 42,
      is_tracking_value_accepted: true,
      im_ref: `${seedLabelForScenario(SCENARIO)}:im-ref`,
      landing_path: '/pricing?im_ref=seed',
      touched_at: touchedAtAffiliate,
      expires_at: '2026-05-10T12:00:00.000Z',
    })
    .returning({ id: kiloclaw_attribution_touches.id });

  const [referralTouch] = await db
    .insert(kiloclaw_attribution_touches)
    .values({
      dedupe_key: `${seedLabelForScenario(SCENARIO)}:touch:referral`,
      user_id: refereeUserId,
      touch_type: ImpactAttributionTouchType.Referral,
      provider: ImpactAttributionTouchProvider.ImpactAdvocate,
      opaque_tracking_value: `${seedLabelForScenario(SCENARIO)}:cookie`,
      tracking_value_length: 40,
      is_tracking_value_accepted: true,
      rs_code: opaqueReferralIdentifier,
      rs_share_medium: 'copy_link',
      rs_engagement_medium: 'direct',
      landing_path: '/pricing?_saasquatch=seed',
      touched_at: touchedAtReferral,
      expires_at: '2026-05-11T09:00:00.000Z',
    })
    .returning({ id: kiloclaw_attribution_touches.id });

  console.log(`[${SEED_SCOPE}] Materializing the qualified referral conversion and rewards`);
  const [referral] = await db
    .insert(kiloclaw_referrals)
    .values({
      referee_user_id: refereeUserId,
      referrer_user_id: referrerUserId,
      source_touch_id: referralTouch.id,
      impact_referral_id: opaqueReferralIdentifier,
    })
    .returning({ id: kiloclaw_referrals.id });

  const [conversion] = await db
    .insert(kiloclaw_referral_conversions)
    .values({
      referee_user_id: refereeUserId,
      referrer_user_id: referrerUserId,
      source_touch_id: referralTouch.id,
      winning_touch_type: KiloClawReferralWinningTouchType.Referral,
      source_payment_id: sourcePaymentId,
      qualified: true,
      converted_at: convertedAt,
    })
    .returning({ id: kiloclaw_referral_conversions.id });

  const [refereeDecision, referrerDecision] = await db
    .insert(kiloclaw_referral_reward_decisions)
    .values([
      {
        conversion_id: conversion.id,
        beneficiary_user_id: refereeUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
        outcome: KiloClawReferralDecisionOutcome.Granted,
        months_granted: 1,
      },
      {
        conversion_id: conversion.id,
        beneficiary_user_id: referrerUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referrer,
        outcome: KiloClawReferralDecisionOutcome.Granted,
        months_granted: 1,
      },
    ])
    .returning({
      id: kiloclaw_referral_reward_decisions.id,
      beneficiaryRole: kiloclaw_referral_reward_decisions.beneficiary_role,
    });

  const refereeDecisionId =
    refereeDecision.beneficiaryRole === 'referee' ? refereeDecision.id : referrerDecision.id;
  const referrerDecisionId =
    refereeDecision.beneficiaryRole === 'referrer' ? refereeDecision.id : referrerDecision.id;

  const [refereeReward, referrerReward] = await db
    .insert(kiloclaw_referral_rewards)
    .values([
      {
        conversion_id: conversion.id,
        decision_id: refereeDecisionId,
        beneficiary_user_id: refereeUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
        months_granted: 1,
        status: KiloClawReferralRewardStatus.Applied,
        applies_to_subscription_id: refereeSubscription.id,
        earned_at: convertedAt,
        applied_at: '2026-04-15T16:40:00.000Z',
      },
      {
        conversion_id: conversion.id,
        decision_id: referrerDecisionId,
        beneficiary_user_id: referrerUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referrer,
        months_granted: 1,
        status: KiloClawReferralRewardStatus.Applied,
        applies_to_subscription_id: referrerSubscription.id,
        earned_at: convertedAt,
        applied_at: '2026-04-15T16:42:00.000Z',
      },
    ])
    .returning({
      id: kiloclaw_referral_rewards.id,
      beneficiaryUserId: kiloclaw_referral_rewards.beneficiary_user_id,
    });

  const refereeRewardId =
    refereeReward.beneficiaryUserId === refereeUserId ? refereeReward.id : referrerReward.id;
  const referrerRewardId =
    refereeReward.beneficiaryUserId === referrerUserId ? refereeReward.id : referrerReward.id;

  await db.insert(kiloclaw_referral_reward_applications).values([
    {
      reward_id: refereeRewardId,
      beneficiary_user_id: refereeUserId,
      subscription_id: refereeSubscription.id,
      previous_renewal_boundary: previousRenewalBoundary,
      new_renewal_boundary: newRenewalBoundary,
      local_operation_id: `${seedLabelForScenario(SCENARIO)}:reward:referee`,
      applied_at: '2026-04-15T16:40:00.000Z',
    },
    {
      reward_id: referrerRewardId,
      beneficiary_user_id: referrerUserId,
      subscription_id: referrerSubscription.id,
      previous_renewal_boundary: previousRenewalBoundary,
      new_renewal_boundary: newRenewalBoundary,
      local_operation_id: `${seedLabelForScenario(SCENARIO)}:reward:referrer`,
      applied_at: '2026-04-15T16:42:00.000Z',
    },
  ]);

  await insertAppliedRewardChangeLog({
    subscription: refereeSubscription,
    previousBoundary: previousRenewalBoundary,
    newBoundary: newRenewalBoundary,
  });
  await insertAppliedRewardChangeLog({
    subscription: referrerSubscription,
    previousBoundary: previousRenewalBoundary,
    newBoundary: newRenewalBoundary,
  });

  await db.insert(credit_transactions).values({
    kilo_user_id: refereeUserId,
    amount_microdollars: -2000000,
    is_free: false,
    description: 'Seed referral happy path paid period',
    credit_category: sourcePaymentId,
    created_at: convertedAt,
  });

  await db.insert(impact_conversion_reports).values({
    conversion_id: conversion.id,
    dedupe_key: `${seedLabelForScenario(SCENARIO)}:impact-report`,
    action_tracker_id: 71659,
    order_id: orderId,
    state: ImpactConversionReportState.Delivered,
    request_payload: {
      orderId,
      sourcePaymentId,
      scenario: SCENARIO,
      winningTouchType: 'referral',
    },
    response_payload: {
      ok: true,
      actionId: `${seedLabelForScenario(SCENARIO)}:impact-action`,
    },
    response_status_code: 200,
    attempt_count: 1,
    delivered_at: '2026-04-15T16:35:00.000Z',
  });

  console.log('');
  console.log('This fixture represents:');
  console.log('- affiliate touch first, referral touch second');
  console.log('- no prior affiliate SALE attribution');
  console.log('- referral wins at first paid conversion');
  console.log('- both rewards already applied to personal credits subscriptions');
  console.log('- Impact sale report already delivered');

  return {
    referrerUserId,
    refereeUserId,
    referralId: referral.id,
    conversionId: conversion.id,
    affiliateTouchId: affiliateTouch.id,
    referralTouchId: referralTouch.id,
    sourcePaymentId,
    orderId,
    referrerSubscriptionId: referrerSubscription.id,
    refereeSubscriptionId: refereeSubscription.id,
  };
}
