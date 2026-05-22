import { beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
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

async function insertReferralInvestigationRow(params: {
  refereeEmail: string;
  sourcePaymentId: string;
  qualified: boolean;
  disqualificationReason: string | null;
  reportState: 'delivered' | 'failed';
}) {
  const referee = await insertTestUser({
    google_user_email: params.refereeEmail,
    normalized_email: params.refereeEmail,
  });
  const [touch] = await db
    .insert(impact_attribution_touches)
    .values({
      dedupe_key: `touch-${params.sourcePaymentId}`,
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
    referee_user_id: referee.id,
    referrer_user_id: referrer.id,
    source_touch_id: touch.id,
    impact_referral_id: 'RS-SUPPORT',
  });
  const [conversion] = await db
    .insert(impact_referral_conversions)
    .values({
      referee_user_id: referee.id,
      referrer_user_id: referrer.id,
      source_touch_id: touch.id,
      winning_touch_type: 'referral',
      source_payment_id: params.sourcePaymentId,
      qualified: params.qualified,
      disqualification_reason: params.disqualificationReason,
      converted_at: '2026-04-10T00:00:00.000Z',
    })
    .returning({ id: impact_referral_conversions.id });
  const [decision] = await db
    .insert(impact_referral_reward_decisions)
    .values({
      conversion_id: conversion.id,
      beneficiary_user_id: referrer.id,
      beneficiary_role: 'referrer',
      outcome: params.qualified ? 'granted' : 'disqualified',
      reason: params.disqualificationReason,
      months_granted: params.qualified ? 1 : 0,
    })
    .returning({ id: impact_referral_reward_decisions.id });

  if (params.qualified) {
    const [reward] = await db
      .insert(impact_referral_rewards)
      .values({
        conversion_id: conversion.id,
        decision_id: decision.id,
        beneficiary_user_id: referrer.id,
        beneficiary_role: 'referrer',
        months_granted: 1,
        status: 'applied',
        earned_at: '2026-04-10T00:00:00.000Z',
        applied_at: '2026-04-10T00:05:00.000Z',
      })
      .returning({ id: impact_referral_rewards.id });
    await db.insert(impact_referral_reward_applications).values({
      reward_id: reward.id,
      beneficiary_user_id: referrer.id,
      subscription_id: crypto.randomUUID(),
      previous_renewal_boundary: '2026-05-01T00:00:00.000Z',
      new_renewal_boundary: '2026-06-01T00:00:00.000Z',
      applied_at: '2026-04-10T00:05:00.000Z',
    });
    await db.insert(impact_advocate_reward_redemptions).values({
      reward_id: reward.id,
      dedupe_key: `reward-redemption-${params.sourcePaymentId}`,
      beneficiary_user_id: referrer.id,
      state: 'redeemed',
      impact_reward_id: `impact-reward-${params.sourcePaymentId}`,
      redeemed_at: '2026-04-10T00:06:00.000Z',
    });
  }

  await db.insert(impact_conversion_reports).values({
    conversion_id: conversion.id,
    dedupe_key: `impact-report-${params.sourcePaymentId}`,
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
          conversion: expect.objectContaining({ qualified: true, disqualificationReason: null }),
          rewardDecisions: [expect.objectContaining({ outcome: 'granted', monthsGranted: 1 })],
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
});
