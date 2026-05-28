import { beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
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
  type User,
} from '@kilocode/db/schema';

let admin: User;
let nonAdmin: User;
let referrer: User;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `admin-referrals-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `not-admin-referrals-${Math.random()}@example.com`,
  });
  referrer = await insertTestUser({
    google_user_email: `referrer-${Math.random()}@example.com`,
    normalized_email: `referrer-${Math.random()}@example.com`,
  });
});

async function insertParticipantRegistration(params: {
  product: 'kiloclaw' | 'kilo_pass';
  state: 'pending' | 'registered' | 'failed';
  attemptState: 'queued' | 'succeeded' | 'failed';
}) {
  const [participant] = await db
    .insert(impact_advocate_participants)
    .values({
      program_key: params.product,
      user_id: referrer.id,
      advocate_id: `${params.product}:${referrer.google_user_email}`,
      advocate_account_id: `${params.product}:${referrer.google_user_email}`,
      contact_email: referrer.google_user_email,
      opaque_referral_identifier: `${params.product}-RS-SUPPORT`,
      registration_state: params.state,
      last_error_code: params.state === 'failed' ? 'invalid_payload' : null,
      last_error_message: params.state === 'failed' ? 'Payload rejected' : null,
    })
    .returning({ id: impact_advocate_participants.id });

  await db.insert(impact_advocate_registration_attempts).values({
    program_key: params.product,
    participant_id: participant.id,
    dedupe_key: `${params.product}-registration-attempt`,
    opaque_cookie_value: `${params.product}-opaque-cookie`,
    cookie_value_length: 23,
    delivery_state: params.attemptState,
    response_status_code: params.attemptState === 'failed' ? 400 : null,
    next_retry_at: params.attemptState === 'queued' ? '2026-04-11T00:00:00.000Z' : null,
  });
}

async function insertReferralInvestigationRow(params: {
  product?: 'kiloclaw' | 'kilo_pass';
  refereeEmail: string;
  sourcePaymentId: string;
  qualified: boolean;
  disqualificationReason: string | null;
  reportState: 'queued' | 'delivered' | 'failed';
  rewardStatus?: 'pending' | 'applied' | 'canceled' | 'review_required';
}) {
  const product = params.product ?? 'kiloclaw';
  const rewardKind = product === 'kilo_pass' ? 'kilo_pass_bonus' : 'kiloclaw_free_month';
  const rewardStatus = params.rewardStatus ?? 'applied';
  const referee = await insertTestUser({
    google_user_email: params.refereeEmail,
    normalized_email: params.refereeEmail,
  });
  const [touch] = await db
    .insert(impact_attribution_touches)
    .values({
      product,
      program_key: product,
      dedupe_key: `touch-${product}-${params.sourcePaymentId}`,
      user_id: referee.id,
      touch_type: 'referral',
      provider: 'impact_advocate',
      opaque_tracking_value: 'opaque-support-only',
      tracking_value_length: 19,
      is_tracking_value_accepted: true,
      rs_code: 'RS-SUPPORT',
      touched_at: '2026-04-01T00:00:00.000Z',
      expires_at: '2026-05-01T00:00:00.000Z',
    })
    .returning({ id: impact_attribution_touches.id });
  await db.insert(impact_referrals).values({
    product,
    referee_user_id: referee.id,
    referrer_user_id: referrer.id,
    source_touch_id: touch.id,
    impact_referral_id: 'RS-SUPPORT',
  });
  const [conversion] = await db
    .insert(impact_referral_conversions)
    .values({
      product,
      referee_user_id: referee.id,
      referrer_user_id: referrer.id,
      source_touch_id: touch.id,
      winning_touch_type: 'referral',
      payment_provider: product === 'kilo_pass' ? 'stripe' : 'credits',
      source_payment_id: params.sourcePaymentId,
      qualified: params.qualified,
      disqualification_reason: params.disqualificationReason,
      converted_at: '2026-04-10T00:00:00.000Z',
    })
    .returning({ id: impact_referral_conversions.id });
  const [decision] = await db
    .insert(impact_referral_reward_decisions)
    .values({
      product,
      conversion_id: conversion.id,
      beneficiary_user_id: referrer.id,
      beneficiary_role: 'referrer',
      outcome: params.qualified ? 'granted' : 'disqualified',
      reason: params.disqualificationReason,
      reward_kind: rewardKind,
      months_granted: product === 'kiloclaw' && params.qualified ? 1 : 0,
      reward_percent: product === 'kilo_pass' ? 0.5 : null,
      source_tier: product === 'kilo_pass' ? 'tier_49' : null,
      reward_amount_usd: product === 'kilo_pass' && params.qualified ? 24.5 : null,
    })
    .returning({ id: impact_referral_reward_decisions.id });

  if (params.qualified) {
    const [reward] = await db
      .insert(impact_referral_rewards)
      .values({
        product,
        conversion_id: conversion.id,
        decision_id: decision.id,
        beneficiary_user_id: referrer.id,
        beneficiary_role: 'referrer',
        reward_kind: rewardKind,
        months_granted: product === 'kiloclaw' ? 1 : 0,
        reward_percent: product === 'kilo_pass' ? 0.5 : null,
        source_tier: product === 'kilo_pass' ? 'tier_49' : null,
        reward_amount_usd: product === 'kilo_pass' ? 24.5 : null,
        status: rewardStatus,
        earned_at: '2026-04-10T00:00:00.000Z',
        applied_at: rewardStatus === 'applied' ? '2026-04-10T00:05:00.000Z' : null,
        expires_at: '2027-04-10T00:00:00.000Z',
        review_reason: rewardStatus === 'review_required' ? 'referral_payment_chargeback' : null,
      })
      .returning({ id: impact_referral_rewards.id });
    if (rewardStatus === 'applied') {
      await db.insert(impact_referral_reward_applications).values({
        product,
        reward_id: reward.id,
        beneficiary_user_id: referrer.id,
        subscription_id: crypto.randomUUID(),
        previous_renewal_boundary: '2026-05-01T00:00:00.000Z',
        new_renewal_boundary: '2026-06-01T00:00:00.000Z',
        applied_at: '2026-04-10T00:05:00.000Z',
      });
    }
    if (product === 'kiloclaw') {
      await db.insert(impact_advocate_reward_redemptions).values({
        reward_id: reward.id,
        dedupe_key: `reward-redemption-${params.sourcePaymentId}`,
        beneficiary_user_id: referrer.id,
        state: 'redeemed',
        impact_reward_id: `impact-reward-${params.sourcePaymentId}`,
        redeemed_at: '2026-04-10T00:06:00.000Z',
      });
    }
  }

  await db.insert(impact_conversion_reports).values({
    conversion_id: conversion.id,
    dedupe_key: `impact-report-${product}-${params.sourcePaymentId}`,
    action_tracker_id: 71659,
    order_id: params.sourcePaymentId,
    state: params.reportState,
    request_payload: { orderId: params.sourcePaymentId },
    response_payload: { actionId: '1000.2000.3000' },
  });

  return referee;
}

describe('admin kiloclaw referrals investigation', () => {
  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.kiloclawReferrals.investigateReferrer({ search: referrer.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('searches by referrer email and returns qualified and disqualified referee diagnostics', async () => {
    const qualifiedReferee = await insertReferralInvestigationRow({
      refereeEmail: `qualified-referee-${Math.random()}@example.com`,
      sourcePaymentId: 'qualified-payment',
      qualified: true,
      disqualificationReason: null,
      reportState: 'delivered',
    });
    const disqualifiedReferee = await insertReferralInvestigationRow({
      refereeEmail: `disqualified-referee-${Math.random()}@example.com`,
      sourcePaymentId: 'disqualified-payment',
      qualified: false,
      disqualificationReason: 'referral_self_referral',
      reportState: 'failed',
    });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.kiloclawReferrals.investigateReferrer({
      search: referrer.google_user_email,
    });

    expect(result.product).toBe('kiloclaw');
    expect(result.productLabel).toBe('KiloClaw');
    expect(result.participantRegistrations).toEqual([]);
    expect(result.referrer).toEqual(
      expect.objectContaining({ id: referrer.id, email: referrer.google_user_email })
    );
    expect(result.referrals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referee: expect.objectContaining({
            id: qualifiedReferee.id,
            email: qualifiedReferee.google_user_email,
          }),
          referral: expect.objectContaining({ product: 'kiloclaw', productLabel: 'KiloClaw' }),
          conversion: expect.objectContaining({
            product: 'kiloclaw',
            paymentProvider: 'credits',
            qualified: true,
            disqualificationReason: null,
          }),
          rewardDecisions: [
            expect.objectContaining({
              product: 'kiloclaw',
              rewardKind: 'kiloclaw_free_month',
              outcome: 'granted',
              monthsGranted: 1,
            }),
          ],
          rewardApplications: [
            expect.objectContaining({
              previousRenewalBoundary: '2026-05-01T00:00:00.000Z',
              newRenewalBoundary: '2026-06-01T00:00:00.000Z',
            }),
          ],
          impactReports: [expect.objectContaining({ state: 'delivered' })],
          impactRewardRedemptions: [expect.objectContaining({ state: 'redeemed' })],
        }),
        expect.objectContaining({
          referee: expect.objectContaining({
            id: disqualifiedReferee.id,
            email: disqualifiedReferee.google_user_email,
          }),
          conversion: expect.objectContaining({
            qualified: false,
            disqualificationReason: 'referral_self_referral',
          }),
          rewardDecisions: [expect.objectContaining({ outcome: 'disqualified' })],
          rewardApplications: [],
          impactReports: [expect.objectContaining({ state: 'failed' })],
          impactRewardRedemptions: [],
        }),
      ])
    );
    expect(result.referrals).toHaveLength(2);

    const reports = await db
      .select()
      .from(impact_conversion_reports)
      .where(eq(impact_conversion_reports.state, 'failed'));
    expect(reports).toHaveLength(1);
  });

  it('filters Kilo Pass referrals and exposes operations states', async () => {
    await insertParticipantRegistration({
      product: 'kilo_pass',
      state: 'pending',
      attemptState: 'queued',
    });
    await insertReferralInvestigationRow({
      product: 'kiloclaw',
      refereeEmail: `claw-referee-${Math.random()}@example.com`,
      sourcePaymentId: 'claw-payment',
      qualified: true,
      disqualificationReason: null,
      reportState: 'delivered',
    });
    const pendingReferee = await insertReferralInvestigationRow({
      product: 'kilo_pass',
      refereeEmail: `kilo-pass-pending-${Math.random()}@example.com`,
      sourcePaymentId: 'kp-pending-invoice',
      qualified: true,
      disqualificationReason: null,
      reportState: 'queued',
      rewardStatus: 'pending',
    });
    const reviewReferee = await insertReferralInvestigationRow({
      product: 'kilo_pass',
      refereeEmail: `kilo-pass-review-${Math.random()}@example.com`,
      sourcePaymentId: 'kp-review-invoice',
      qualified: true,
      disqualificationReason: null,
      reportState: 'failed',
      rewardStatus: 'review_required',
    });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.kiloclawReferrals.investigateReferrer({
      search: referrer.id,
      product: 'kilo_pass',
    });

    expect(result.product).toBe('kilo_pass');
    expect(result.productLabel).toBe('Kilo Pass');
    expect(result.participantRegistrations).toEqual([
      expect.objectContaining({
        programKey: 'kilo_pass',
        registrationState: 'pending',
        latestAttempt: expect.objectContaining({
          deliveryState: 'queued',
          nextRetryAt: '2026-04-11T00:00:00.000Z',
        }),
      }),
    ]);
    expect(result.referrals).toHaveLength(2);
    expect(result.referrals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referee: expect.objectContaining({ id: pendingReferee.id }),
          referral: expect.objectContaining({ product: 'kilo_pass', productLabel: 'Kilo Pass' }),
          conversion: expect.objectContaining({
            product: 'kilo_pass',
            paymentProvider: 'stripe',
            qualified: true,
          }),
          rewardDecisions: [
            expect.objectContaining({
              rewardKind: 'kilo_pass_bonus',
              rewardPercent: 0.5,
              sourceTier: 'tier_49',
              rewardAmountUsd: 24.5,
            }),
          ],
          rewards: [
            expect.objectContaining({
              rewardKind: 'kilo_pass_bonus',
              status: 'pending',
              rewardAmountUsd: 24.5,
              expiresAt: '2027-04-10T00:00:00.000Z',
            }),
          ],
          rewardApplications: [],
          impactReports: [expect.objectContaining({ state: 'queued' })],
          impactRewardRedemptions: [],
        }),
        expect.objectContaining({
          referee: expect.objectContaining({ id: reviewReferee.id }),
          rewards: [
            expect.objectContaining({
              status: 'review_required',
              reviewReason: 'referral_payment_chargeback',
            }),
          ],
          impactReports: [expect.objectContaining({ state: 'failed' })],
        }),
      ])
    );
  });
});
