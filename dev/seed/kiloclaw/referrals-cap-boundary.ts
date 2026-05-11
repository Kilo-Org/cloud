import {
  kiloclaw_referral_conversions,
  kiloclaw_referral_reward_decisions,
  kiloclaw_referral_rewards,
  kiloclaw_referrals,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  KiloClawReferralBeneficiaryRole,
  KiloClawReferralDecisionOutcome,
  KiloClawReferralRewardStatus,
  KiloClawReferralWinningTouchType,
} from '@kilocode/db/schema-types';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';
import {
  addDays,
  assertUserCount,
  cleanupKiloClawReferralSeedScenario,
  insertImpactAdvocateParticipant,
  insertPersonalSubscription,
  insertSeedUsers,
  seedEmail,
  seedOpaqueReferralIdentifier,
  seedSourcePaymentId,
  seedUserId,
} from '../lib/kiloclaw-referrals';

const SCENARIO = 'referrals-cap-boundary';
const SEED_SCOPE = `kiloclaw/${SCENARIO}`;
const referrerUserId = seedUserId(SCENARIO, 'referrer');
const referrerEmail = seedEmail(SCENARIO, 'referrer');
const currentRefereeUserId = seedUserId(SCENARIO, 'current-referee');
const currentRefereeEmail = seedEmail(SCENARIO, 'current-referee');
const opaqueReferralIdentifier = seedOpaqueReferralIdentifier(SCENARIO, 'primary');

function buildHistoricalReferee(i: number) {
  const role = `historical-referee-${i}`;
  return {
    id: seedUserId(SCENARIO, role),
    email: seedEmail(SCENARIO, role),
    name: `Seed Cap Boundary Referee ${i}`,
  };
}

export async function run(): Promise<SeedResult> {
  const db = getSeedDb();
  const historicalReferees = Array.from({ length: 12 }, (_, index) =>
    buildHistoricalReferee(index + 1)
  );
  const userIds = [
    referrerUserId,
    currentRefereeUserId,
    ...historicalReferees.map(user => user.id),
  ];

  console.log(`[${SEED_SCOPE}] Resetting existing seed data`);
  await cleanupKiloClawReferralSeedScenario({
    scenario: SCENARIO,
    userIds,
  });

  console.log(`[${SEED_SCOPE}] Inserting referrer plus historical and current referees`);
  await insertSeedUsers([
    {
      id: referrerUserId,
      email: referrerEmail,
      name: 'Seed Cap Boundary Referrer',
    },
    {
      id: currentRefereeUserId,
      email: currentRefereeEmail,
      name: 'Seed Cap Boundary Current Referee',
    },
    ...historicalReferees,
  ]);
  await assertUserCount({ userIds, expectedCount: userIds.length });

  console.log(
    `[${SEED_SCOPE}] Inserting the referrer participant and an active personal subscription`
  );
  await insertImpactAdvocateParticipant({
    userId: referrerUserId,
    email: referrerEmail,
    opaqueReferralIdentifier,
    registeredAt: '2026-01-01T12:00:00.000Z',
  });
  const { subscription: referrerSubscription } = await insertPersonalSubscription({
    userId: referrerUserId,
    sandboxId: `sandbox-${referrerUserId}`,
    name: 'Seed Cap Boundary Referrer',
    plan: 'standard',
    status: 'active',
    paymentSource: 'credits',
    currentPeriodStart: '2026-12-01T00:00:00.000Z',
    currentPeriodEnd: '2027-01-01T00:00:00.000Z',
    creditRenewalAt: '2027-01-01T00:00:00.000Z',
  });

  console.log(`[${SEED_SCOPE}] Inserting 12 previously granted referrer months`);
  for (const [index, historicalReferee] of historicalReferees.entries()) {
    const convertedAt = addDays('2026-01-15T12:00:00.000Z', index * 20);
    const [referral] = await db
      .insert(kiloclaw_referrals)
      .values({
        referee_user_id: historicalReferee.id,
        referrer_user_id: referrerUserId,
        impact_referral_id: opaqueReferralIdentifier,
      })
      .returning({ id: kiloclaw_referrals.id });

    const [conversion] = await db
      .insert(kiloclaw_referral_conversions)
      .values({
        referee_user_id: historicalReferee.id,
        referrer_user_id: referrerUserId,
        winning_touch_type: KiloClawReferralWinningTouchType.Referral,
        source_payment_id: seedSourcePaymentId(SCENARIO, `historical-${index + 1}`),
        qualified: true,
        converted_at: convertedAt,
      })
      .returning({ id: kiloclaw_referral_conversions.id });

    const [refereeDecision, referrerDecision] = await db
      .insert(kiloclaw_referral_reward_decisions)
      .values([
        {
          conversion_id: conversion.id,
          beneficiary_user_id: historicalReferee.id,
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

    await db.insert(kiloclaw_referral_rewards).values([
      {
        conversion_id: conversion.id,
        decision_id: refereeDecisionId,
        beneficiary_user_id: historicalReferee.id,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
        months_granted: 1,
        status: KiloClawReferralRewardStatus.Earned,
        earned_at: convertedAt,
      },
      {
        conversion_id: conversion.id,
        decision_id: referrerDecisionId,
        beneficiary_user_id: referrerUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referrer,
        months_granted: 1,
        status: KiloClawReferralRewardStatus.Earned,
        applies_to_subscription_id: referrerSubscription.id,
        earned_at: convertedAt,
      },
    ]);

    console.log(
      `  - historical referee ${index + 1}: referral ${referral.id}, conversion ${conversion.id}`
    );
  }

  console.log(
    `[${SEED_SCOPE}] Inserting the next qualified conversion with a cap-limited referrer outcome`
  );
  const [currentReferral] = await db
    .insert(kiloclaw_referrals)
    .values({
      referee_user_id: currentRefereeUserId,
      referrer_user_id: referrerUserId,
      impact_referral_id: opaqueReferralIdentifier,
    })
    .returning({ id: kiloclaw_referrals.id });

  const [currentConversion] = await db
    .insert(kiloclaw_referral_conversions)
    .values({
      referee_user_id: currentRefereeUserId,
      referrer_user_id: referrerUserId,
      winning_touch_type: KiloClawReferralWinningTouchType.Referral,
      source_payment_id: seedSourcePaymentId(SCENARIO, 'current-13th'),
      qualified: true,
      converted_at: '2026-12-15T12:00:00.000Z',
    })
    .returning({ id: kiloclaw_referral_conversions.id });

  const [currentRefereeDecision, currentReferrerDecision] = await db
    .insert(kiloclaw_referral_reward_decisions)
    .values([
      {
        conversion_id: currentConversion.id,
        beneficiary_user_id: currentRefereeUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
        outcome: KiloClawReferralDecisionOutcome.Granted,
        months_granted: 1,
      },
      {
        conversion_id: currentConversion.id,
        beneficiary_user_id: referrerUserId,
        beneficiary_role: KiloClawReferralBeneficiaryRole.Referrer,
        outcome: KiloClawReferralDecisionOutcome.CapLimited,
        reason: 'referral_referrer_cap_reached',
        months_granted: 0,
      },
    ])
    .returning({
      id: kiloclaw_referral_reward_decisions.id,
      beneficiaryRole: kiloclaw_referral_reward_decisions.beneficiary_role,
    });

  const currentGrantedDecisionId =
    currentRefereeDecision.beneficiaryRole === 'referee'
      ? currentRefereeDecision.id
      : currentReferrerDecision.id;
  const currentCapLimitedDecisionId =
    currentRefereeDecision.beneficiaryRole === 'referrer'
      ? currentRefereeDecision.id
      : currentReferrerDecision.id;

  await db.insert(kiloclaw_referral_rewards).values({
    conversion_id: currentConversion.id,
    decision_id: currentGrantedDecisionId,
    beneficiary_user_id: currentRefereeUserId,
    beneficiary_role: KiloClawReferralBeneficiaryRole.Referee,
    months_granted: 1,
    status: KiloClawReferralRewardStatus.Earned,
    earned_at: '2026-12-15T12:00:00.000Z',
  });

  const referrerGrantedMonths = await db
    .select({ id: kiloclaw_referral_reward_decisions.id })
    .from(kiloclaw_referral_reward_decisions)
    .where(
      and(
        eq(kiloclaw_referral_reward_decisions.beneficiary_user_id, referrerUserId),
        eq(
          kiloclaw_referral_reward_decisions.beneficiary_role,
          KiloClawReferralBeneficiaryRole.Referrer
        ),
        eq(kiloclaw_referral_reward_decisions.outcome, KiloClawReferralDecisionOutcome.Granted)
      )
    );

  console.log('');
  console.log('This fixture represents:');
  console.log('- 12 previously granted referrer reward months already recorded');
  console.log('- a 13th qualified referral where the referee still gets a reward');
  console.log(
    '- the referrer decision is recorded as cap-limited with no extra referrer reward row'
  );

  return {
    referrerUserId,
    currentRefereeUserId,
    currentReferralId: currentReferral.id,
    currentConversionId: currentConversion.id,
    currentCapLimitedDecisionId,
    referrerSubscriptionId: referrerSubscription.id,
    grantedReferrerMonthsBeforeCapDecision: referrerGrantedMonths.length,
  };
}
