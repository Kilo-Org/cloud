import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

jest.mock('@/lib/impact', () => {
  const actual = jest.requireActual('@/lib/impact');
  return {
    ...actual,
    isImpactConfigured: jest.fn(() => true),
    sendImpactConversionPayload: jest.fn(async () => ({ ok: true, delivery: 'accepted' })),
  };
});

jest.mock('@/lib/impact/advocate', () => {
  const actual = jest.requireActual('@/lib/impact/advocate');
  return {
    ...actual,
    isImpactAdvocateConfigured: jest.fn(() => true),
    sendImpactAdvocateRewardLookupPayload: jest.fn(async () => ({
      ok: true,
      statusCode: 200,
      rewards: [
        {
          id: 'impact-kilo-pass-reward',
          type: 'CREDIT',
          amount: 24.5,
          unit: 'Kilo Pass Bonus Credits',
        },
      ],
      responseBody:
        '{"rewards":[{"id":"impact-kilo-pass-reward","type":"CREDIT","amount":24.5,"unit":"Kilo Pass Bonus Credits"}]}',
    })),
    sendImpactAdvocateRewardRedemptionPayload: jest.fn(async () => ({
      ok: true,
      statusCode: 200,
      responseBody: '{}',
    })),
  };
});

jest.mock('@/lib/stripe-client', () => ({
  client: {
    subscriptions: {
      update: jest.fn(async () => ({})),
    },
  },
}));

import { cleanupDbForTest, db } from '@/lib/drizzle';
import type { isImpactConfigured, sendImpactConversionPayload } from '@/lib/impact';
import type {
  isImpactAdvocateConfigured,
  sendImpactAdvocateRewardLookupPayload,
  sendImpactAdvocateRewardRedemptionPayload,
} from '@/lib/impact/advocate';
import {
  expirePendingKiloPassReferralRewards,
  markPersonalKiloPassReferralPaymentAdverse,
  processPersonalKiloPassStripePaidConversion,
} from '@/lib/impact/kilo-pass-referrals';
import { dispatchQueuedImpactAdvocateRewardRedemptions } from '@/lib/impact/kiloclaw-referrals';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  deleted_user_email_tombstones,
  impact_advocate_participants,
  impact_advocate_reward_redemptions,
  impact_attribution_touches,
  impact_conversion_reports,
  impact_referral_conversions,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  kilo_pass_issuances,
  kilo_pass_subscriptions,
  user_affiliate_attributions,
} from '@kilocode/db/schema';
import {
  ImpactAdvocateProgramKey,
  ImpactAttributionTouchProvider,
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
  KiloPassIssuanceSource,
  KiloPassPaymentProvider,
  KiloPassTier,
  KiloPassWelcomePromoEligibilityReason,
} from '@kilocode/db/schema-types';

const impactMock = jest.requireMock('@/lib/impact') as {
  isImpactConfigured: jest.MockedFunction<typeof isImpactConfigured>;
  sendImpactConversionPayload: jest.MockedFunction<typeof sendImpactConversionPayload>;
};
const advocateMock = jest.requireMock('@/lib/impact/advocate') as {
  isImpactAdvocateConfigured: jest.MockedFunction<typeof isImpactAdvocateConfigured>;
  sendImpactAdvocateRewardLookupPayload: jest.MockedFunction<
    typeof sendImpactAdvocateRewardLookupPayload
  >;
  sendImpactAdvocateRewardRedemptionPayload: jest.MockedFunction<
    typeof sendImpactAdvocateRewardRedemptionPayload
  >;
};
const mockIsImpactConfigured = impactMock.isImpactConfigured;
const mockIsImpactAdvocateConfigured = advocateMock.isImpactAdvocateConfigured;
const mockSendImpactAdvocateRewardLookupPayload =
  advocateMock.sendImpactAdvocateRewardLookupPayload;
const mockSendImpactAdvocateRewardRedemptionPayload =
  advocateMock.sendImpactAdvocateRewardRedemptionPayload;
const mockSendImpactConversionPayload = impactMock.sendImpactConversionPayload;

beforeEach(async () => {
  await cleanupDbForTest();
  jest.clearAllMocks();
  mockIsImpactConfigured.mockReturnValue(true);
  mockIsImpactAdvocateConfigured.mockReturnValue(true);
  mockSendImpactConversionPayload.mockResolvedValue({ ok: true, delivery: 'accepted' });
  mockSendImpactAdvocateRewardLookupPayload.mockResolvedValue({
    ok: true,
    statusCode: 200,
    rewards: [
      {
        id: 'impact-kilo-pass-reward',
        type: 'CREDIT',
        amount: 24.5,
        unit: 'Kilo Pass Bonus Credits',
      },
    ],
    responseBody:
      '{"rewards":[{"id":"impact-kilo-pass-reward","type":"CREDIT","amount":24.5,"unit":"Kilo Pass Bonus Credits"}]}',
  });
  mockSendImpactAdvocateRewardRedemptionPayload.mockResolvedValue({
    ok: true,
    statusCode: 200,
    responseBody: '{}',
  });
});

async function insertKiloPassSubscription(params: {
  userId: string;
  tier?: KiloPassTier;
  cadence?: KiloPassCadence;
  stripeSubscriptionId?: string;
}) {
  const stripeSubscriptionId = params.stripeSubscriptionId ?? `sub_${randomUUID()}`;
  const [subscription] = await db
    .insert(kilo_pass_subscriptions)
    .values({
      kilo_user_id: params.userId,
      payment_provider: KiloPassPaymentProvider.Stripe,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: params.tier ?? KiloPassTier.Tier49,
      cadence: params.cadence ?? KiloPassCadence.Monthly,
      status: 'active',
      started_at: '2026-01-02T00:00:00.000Z',
    })
    .returning({ id: kilo_pass_subscriptions.id });
  if (!subscription) throw new Error('Failed to insert Kilo Pass subscription');
  return subscription.id;
}

async function seedCurrentIssuance(subscriptionId: string, invoiceId: string): Promise<void> {
  await db.insert(kilo_pass_issuances).values({
    kilo_pass_subscription_id: subscriptionId,
    issue_month: '2026-01-01',
    source: KiloPassIssuanceSource.StripeInvoice,
    stripe_invoice_id: invoiceId,
  });
}

async function insertParticipant(userId: string, referralCode = `code_${randomUUID()}`) {
  await db.insert(impact_advocate_participants).values({
    program_key: ImpactAdvocateProgramKey.KiloPass,
    user_id: userId,
    advocate_id: `${userId}@example.com`,
    advocate_account_id: `${userId}@example.com`,
    contact_email: `${userId}@example.com`,
    opaque_referral_identifier: referralCode,
    registration_state: 'registered',
    registered_at: '2026-01-01T00:00:00.000Z',
  });
  return referralCode;
}

async function insertTouch(params: {
  userId: string;
  type: 'referral' | 'affiliate';
  referralCode?: string;
  touchedAt?: string;
  saleAttributedAt?: string | null;
}) {
  const touchedAt = params.touchedAt ?? '2026-01-01T00:00:00.000Z';
  const [touch] = await db
    .insert(impact_attribution_touches)
    .values({
      product: ImpactReferralProduct.KiloPass,
      program_key: params.type === 'referral' ? ImpactAdvocateProgramKey.KiloPass : null,
      dedupe_key: randomUUID(),
      user_id: params.userId,
      touch_type:
        params.type === 'referral'
          ? ImpactAttributionTouchType.Referral
          : ImpactAttributionTouchType.Affiliate,
      provider:
        params.type === 'referral'
          ? ImpactAttributionTouchProvider.ImpactAdvocate
          : ImpactAttributionTouchProvider.ImpactPerformance,
      opaque_tracking_value:
        params.type === 'referral' ? 'opaque-referral-cookie' : 'impact-click-id',
      tracking_value_length: 20,
      is_tracking_value_accepted: true,
      rs_code: params.type === 'referral' ? params.referralCode : null,
      im_ref: params.type === 'affiliate' ? 'impact-click-id' : null,
      touched_at: touchedAt,
      expires_at: '2026-01-31T00:00:00.000Z',
      sale_attributed_at: params.saleAttributedAt ?? null,
    })
    .returning({ id: impact_attribution_touches.id });
  if (!touch) throw new Error('Failed to insert touch');
  return touch.id;
}

async function processInvoice(params: {
  refereeId: string;
  subscriptionId: string;
  invoiceId?: string;
  tier?: KiloPassTier;
  cadence?: KiloPassCadence;
  amount?: number;
  welcomePromoEligibilityReason?: KiloPassWelcomePromoEligibilityReason;
}) {
  const invoiceId = params.invoiceId ?? `inv_${randomUUID()}`;
  await seedCurrentIssuance(params.subscriptionId, invoiceId);
  return await processPersonalKiloPassStripePaidConversion({
    userId: params.refereeId,
    kiloPassSubscriptionId: params.subscriptionId,
    sourcePaymentId: invoiceId,
    orderId: invoiceId,
    amount: params.amount ?? 49,
    currencyCode: 'usd',
    itemCategory: 'kilo-pass-tier-49-monthly',
    itemName: 'Kilo Pass Tier 49 Monthly',
    itemSku: 'price_kilo_pass_49_monthly',
    sourceTier: params.tier ?? KiloPassTier.Tier49,
    cadence: params.cadence ?? KiloPassCadence.Monthly,
    welcomePromoEligibilityReason: params.welcomePromoEligibilityReason,
    convertedAt: new Date('2026-01-03T00:00:00.000Z'),
  });
}

async function seedKiloPassReferralRewardsForAdversePayment(params: {
  invoiceId?: string;
  statuses: Array<(typeof ImpactReferralRewardStatus)[keyof typeof ImpactReferralRewardStatus]>;
}) {
  const invoiceId = params.invoiceId ?? `inv_adverse_${randomUUID()}`;
  const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
  const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
  const [conversion] = await db
    .insert(impact_referral_conversions)
    .values({
      product: ImpactReferralProduct.KiloPass,
      referee_user_id: referee.id,
      referrer_user_id: referrer.id,
      winning_touch_type: ImpactReferralWinningTouchType.Referral,
      payment_provider: ImpactReferralPaymentProvider.Stripe,
      source_payment_id: invoiceId,
      qualified: true,
      converted_at: '2026-01-03T00:00:00.000Z',
    })
    .returning({ id: impact_referral_conversions.id });
  if (!conversion) throw new Error('Failed to insert conversion');

  const roles = [ImpactReferralBeneficiaryRole.Referee, ImpactReferralBeneficiaryRole.Referrer];
  const beneficiaries = [referee.id, referrer.id];
  const rewards = [];
  for (const [index, status] of params.statuses.entries()) {
    const [decision] = await db
      .insert(impact_referral_reward_decisions)
      .values({
        product: ImpactReferralProduct.KiloPass,
        conversion_id: conversion.id,
        beneficiary_user_id: beneficiaries[index] ?? referee.id,
        beneficiary_role: roles[index] ?? ImpactReferralBeneficiaryRole.Referee,
        outcome: ImpactReferralDecisionOutcome.Granted,
        reward_kind: ImpactReferralRewardKind.KiloPassBonus,
        months_granted: 0,
        reward_percent: 0.5,
        source_tier: KiloPassTier.Tier49,
        reward_amount_usd: 24.5,
      })
      .returning({ id: impact_referral_reward_decisions.id });
    if (!decision) throw new Error('Failed to insert decision');

    const [reward] = await db
      .insert(impact_referral_rewards)
      .values({
        product: ImpactReferralProduct.KiloPass,
        conversion_id: conversion.id,
        decision_id: decision.id,
        beneficiary_user_id: beneficiaries[index] ?? referee.id,
        beneficiary_role: roles[index] ?? ImpactReferralBeneficiaryRole.Referee,
        reward_kind: ImpactReferralRewardKind.KiloPassBonus,
        months_granted: 0,
        reward_percent: 0.5,
        source_tier: KiloPassTier.Tier49,
        reward_amount_usd: 24.5,
        status,
        earned_at: '2026-01-03T00:00:00.000Z',
        applied_at:
          status === ImpactReferralRewardStatus.Applied ? '2026-02-01T00:00:00.000Z' : null,
        expires_at: '2027-01-03T00:00:00.000Z',
      })
      .returning({ id: impact_referral_rewards.id });
    if (!reward) throw new Error('Failed to insert reward');
    rewards.push(reward);
  }

  return { invoiceId, conversionId: conversion.id, rewardIds: rewards.map(reward => reward.id) };
}

describe('Kilo Pass Impact referral conversions', () => {
  test('referral winner grants double-sided pending rewards, queues Impact SALE and reward redemptions, and suppresses affiliate SALE', async () => {
    const referrer = await insertTestUser({
      google_user_email: 'referrer@example.com',
      normalized_email: 'referrer@example.com',
      created_at: '2025-12-01T00:00:00.000Z',
    });
    const referee = await insertTestUser({
      google_user_email: 'referee@example.com',
      created_at: '2026-01-02T00:00:00.000Z',
      normalized_email: 'referee@example.com',
    });
    const referralCode = await insertParticipant(referrer.id);
    await insertTouch({
      userId: referee.id,
      type: 'affiliate',
      touchedAt: '2026-01-01T00:00:00.000Z',
    });
    await insertTouch({
      userId: referee.id,
      type: 'referral',
      referralCode,
      touchedAt: '2026-01-01T01:00:00.000Z',
    });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });

    const disposition = await processInvoice({ refereeId: referee.id, subscriptionId });

    expect(disposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.Referral,
        disqualificationReason: null,
      })
    );

    const rewards = await db
      .select()
      .from(impact_referral_rewards)
      .where(eq(impact_referral_rewards.conversion_id, disposition.conversionId ?? ''));
    expect(rewards).toHaveLength(2);
    expect(rewards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          product: ImpactReferralProduct.KiloPass,
          beneficiary_user_id: referee.id,
          beneficiary_role: ImpactReferralBeneficiaryRole.Referee,
          reward_kind: ImpactReferralRewardKind.KiloPassBonus,
          reward_amount_usd: 24.5,
          status: ImpactReferralRewardStatus.Pending,
        }),
        expect.objectContaining({
          product: ImpactReferralProduct.KiloPass,
          beneficiary_user_id: referrer.id,
          beneficiary_role: ImpactReferralBeneficiaryRole.Referrer,
          reward_amount_usd: 24.5,
          status: ImpactReferralRewardStatus.Pending,
        }),
      ])
    );

    const redemptions = await db.select().from(impact_advocate_reward_redemptions);
    expect(redemptions).toHaveLength(2);
    expect(redemptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beneficiary_user_id: referee.id,
          state: 'queued',
          request_payload: expect.objectContaining({
            programKey: ImpactAdvocateProgramKey.KiloPass,
            lookup: expect.objectContaining({
              accountId: 'referee@example.com',
              userId: 'referee@example.com',
              rewardTypeFilter: 'CREDIT',
            }),
            redemption: { amount: 24.5, unit: 'Kilo Pass Bonus Credits' },
          }),
        }),
        expect.objectContaining({
          beneficiary_user_id: referrer.id,
          state: 'queued',
          request_payload: expect.objectContaining({
            programKey: ImpactAdvocateProgramKey.KiloPass,
            lookup: expect.objectContaining({
              accountId: 'referrer@example.com',
              userId: 'referrer@example.com',
              rewardTypeFilter: 'CREDIT',
            }),
            redemption: { amount: 24.5, unit: 'Kilo Pass Bonus Credits' },
          }),
        }),
      ])
    );

    const redemptionSummary = await dispatchQueuedImpactAdvocateRewardRedemptions();
    expect(redemptionSummary).toEqual({ claimed: 2, redeemed: 2, retried: 0, failed: 0 });
    expect(mockSendImpactAdvocateRewardLookupPayload).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'referee@example.com' }),
      { programKey: ImpactAdvocateProgramKey.KiloPass }
    );
    expect(mockSendImpactAdvocateRewardLookupPayload).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'referrer@example.com' }),
      { programKey: ImpactAdvocateProgramKey.KiloPass }
    );
    expect(mockSendImpactAdvocateRewardRedemptionPayload).toHaveBeenCalledWith(
      { rewardId: 'impact-kilo-pass-reward', amount: 24.5, unit: 'Kilo Pass Bonus Credits' },
      { programKey: ImpactAdvocateProgramKey.KiloPass }
    );

    const report = await db.query.impact_conversion_reports.findFirst({
      where: eq(impact_conversion_reports.conversion_id, disposition.conversionId ?? ''),
    });
    expect(report).toEqual(
      expect.objectContaining({
        action_tracker_id: 71659,
        order_id: expect.stringMatching(/^inv_/),
        state: ImpactConversionReportState.Delivered,
        request_payload: expect.objectContaining({
          ItemCategory1: 'kilo-pass-tier-49-monthly',
          ItemSubTotal1: '49.00',
        }),
      })
    );
  });

  test('affiliate sale-attributed before referral wins and is marked sale-attributed for Kilo Pass', async () => {
    const referrer = await insertTestUser();
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const referralCode = await insertParticipant(referrer.id);
    const affiliateTouchId = await insertTouch({
      userId: referee.id,
      type: 'affiliate',
      touchedAt: '2026-01-01T00:00:00.000Z',
      saleAttributedAt: '2026-01-01T00:30:00.000Z',
    });
    await insertTouch({
      userId: referee.id,
      type: 'referral',
      referralCode,
      touchedAt: '2026-01-01T01:00:00.000Z',
    });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });

    const disposition = await processInvoice({ refereeId: referee.id, subscriptionId });

    expect(disposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: true,
        winningTouchType: ImpactReferralWinningTouchType.Affiliate,
        disqualificationReason: 'referral_affiliate_won',
      })
    );
    const touch = await db.query.impact_attribution_touches.findFirst({
      where: eq(impact_attribution_touches.id, affiliateTouchId),
    });
    expect(new Date(touch?.sale_attributed_at ?? '').toISOString()).toBe(
      '2026-01-01T00:30:00.000Z'
    );
  });

  test('only affiliate attribution preserves affiliate SALE and creates no referral rewards', async () => {
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const affiliateTouchId = await insertTouch({ userId: referee.id, type: 'affiliate' });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });

    const disposition = await processInvoice({ refereeId: referee.id, subscriptionId });

    expect(disposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: true,
        winningTouchType: ImpactReferralWinningTouchType.Affiliate,
        disqualificationReason: 'referral_affiliate_won',
      })
    );
    expect(await db.select().from(impact_referral_rewards)).toHaveLength(0);
    const touch = await db.query.impact_attribution_touches.findFirst({
      where: eq(impact_attribution_touches.id, affiliateTouchId),
    });
    expect(new Date(touch?.sale_attributed_at ?? '').toISOString()).toBe(
      '2026-01-03T00:00:00.000Z'
    );
  });

  test('historical affiliate attribution without product-scoped touch preserves affiliate SALE', async () => {
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    await db.insert(user_affiliate_attributions).values({
      user_id: referee.id,
      provider: 'impact',
      tracking_id: '',
    });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });

    const disposition = await processInvoice({ refereeId: referee.id, subscriptionId });

    expect(disposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: true,
        winningTouchType: ImpactReferralWinningTouchType.Affiliate,
        disqualificationReason: 'referral_affiliate_won',
      })
    );
    expect(await db.select().from(impact_referral_rewards)).toHaveLength(0);
  });

  test('missing attribution and expired product-scoped touches suppress affiliate SALE reporting', async () => {
    const noTouchReferee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const noTouchSubscriptionId = await insertKiloPassSubscription({
      userId: noTouchReferee.id,
    });

    const noTouchDisposition = await processInvoice({
      refereeId: noTouchReferee.id,
      subscriptionId: noTouchSubscriptionId,
    });

    expect(noTouchDisposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.None,
        disqualificationReason: 'referral_no_valid_attribution',
      })
    );

    await cleanupDbForTest();
    const expiredAffiliateReferee = await insertTestUser({
      created_at: '2026-01-02T00:00:00.000Z',
    });
    await db.insert(user_affiliate_attributions).values({
      user_id: expiredAffiliateReferee.id,
      provider: 'impact',
      tracking_id: 'historical-affiliate-click',
    });
    await insertTouch({
      userId: expiredAffiliateReferee.id,
      type: 'affiliate',
      touchedAt: '2025-12-01T00:00:00.000Z',
    });
    const expiredAffiliateSubscriptionId = await insertKiloPassSubscription({
      userId: expiredAffiliateReferee.id,
    });

    const expiredAffiliateDisposition = await processInvoice({
      refereeId: expiredAffiliateReferee.id,
      subscriptionId: expiredAffiliateSubscriptionId,
    });

    expect(expiredAffiliateDisposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.None,
        disqualificationReason: 'referral_no_valid_attribution',
      })
    );

    await cleanupDbForTest();
    const expiredReferralReferee = await insertTestUser({
      created_at: '2026-01-02T00:00:00.000Z',
    });
    await db.insert(user_affiliate_attributions).values({
      user_id: expiredReferralReferee.id,
      provider: 'impact',
      tracking_id: 'historical-affiliate-click',
    });
    await insertTouch({
      userId: expiredReferralReferee.id,
      type: 'referral',
      touchedAt: '2025-12-01T00:00:00.000Z',
    });
    const expiredReferralSubscriptionId = await insertKiloPassSubscription({
      userId: expiredReferralReferee.id,
    });

    const expiredReferralDisposition = await processInvoice({
      refereeId: expiredReferralReferee.id,
      subscriptionId: expiredReferralSubscriptionId,
    });

    expect(expiredReferralDisposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.None,
        disqualificationReason: 'referral_no_valid_attribution',
      })
    );
  });

  test('only referral attribution grants double-sided pending rewards', async () => {
    const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const referralCode = await insertParticipant(referrer.id);
    await insertTouch({ userId: referee.id, type: 'referral', referralCode });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });

    const disposition = await processInvoice({ refereeId: referee.id, subscriptionId });

    expect(disposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.Referral,
        disqualificationReason: null,
      })
    );
    const rewards = await db
      .select()
      .from(impact_referral_rewards)
      .where(eq(impact_referral_rewards.conversion_id, disposition.conversionId ?? ''));
    expect(rewards).toHaveLength(2);
    expect(rewards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ beneficiary_user_id: referee.id }),
        expect.objectContaining({ beneficiary_user_id: referrer.id }),
      ])
    );
  });

  test('reused payment fingerprint does not grant referral rewards', async () => {
    const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const referralCode = await insertParticipant(referrer.id);
    await insertTouch({ userId: referee.id, type: 'referral', referralCode });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });

    const disposition = await processInvoice({
      refereeId: referee.id,
      subscriptionId,
      welcomePromoEligibilityReason:
        KiloPassWelcomePromoEligibilityReason.FingerprintPreviouslyClaimed,
    });

    expect(disposition).toEqual(
      expect.objectContaining({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: ImpactReferralWinningTouchType.Referral,
        disqualificationReason: 'referral_payment_fingerprint_previously_claimed',
      })
    );
    expect(await db.select().from(impact_referral_rewards)).toHaveLength(0);
  });

  test('renewal, prior subscription, deleted tombstone, and self-referral do not grant rewards', async () => {
    const cases = ['renewal', 'prior_subscription', 'deleted_tombstone', 'self_referral'] as const;

    for (const scenario of cases) {
      await cleanupDbForTest();
      const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
      const referee =
        scenario === 'self_referral'
          ? referrer
          : await insertTestUser({
              created_at: '2026-01-02T00:00:00.000Z',
              normalized_email: `${scenario}@example.com`,
            });
      const referralCode = await insertParticipant(referrer.id);
      await insertTouch({ userId: referee.id, type: 'referral', referralCode });
      const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });
      if (scenario === 'renewal') {
        await db.insert(kilo_pass_issuances).values({
          kilo_pass_subscription_id: subscriptionId,
          issue_month: '2025-12-01',
          source: KiloPassIssuanceSource.StripeInvoice,
          stripe_invoice_id: `inv_prior_${randomUUID()}`,
        });
      }
      if (scenario === 'prior_subscription') {
        await insertKiloPassSubscription({ userId: referee.id });
      }
      if (scenario === 'deleted_tombstone') {
        await db.insert(deleted_user_email_tombstones).values({
          normalized_email_hash: '3c19ee1212333d8548ac77b54240971338dd8e4c3d5b6723b1c219666e74eac3',
        });
      }

      const disposition = await processInvoice({ refereeId: referee.id, subscriptionId });
      const rewards = await db.select().from(impact_referral_rewards);
      expect({ scenario, rewardCount: rewards.length }).toEqual({ scenario, rewardCount: 0 });
      expect(disposition.winningTouchType).toBe(ImpactReferralWinningTouchType.Referral);
      expect(disposition.disqualificationReason).toMatch(/^referral_/);
    }
  });

  test('referrer cap limits only referrer reward and invoice retry is idempotent', async () => {
    const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const referralCode = await insertParticipant(referrer.id);
    for (let i = 0; i < 5; i++) {
      const [conversion] = await db
        .insert(impact_referral_conversions)
        .values({
          product: ImpactReferralProduct.KiloPass,
          referee_user_id: referee.id,
          referrer_user_id: referrer.id,
          winning_touch_type: ImpactReferralWinningTouchType.Referral,
          payment_provider: ImpactReferralPaymentProvider.Stripe,
          source_payment_id: `seed_inv_${i}`,
          qualified: true,
          converted_at: '2025-12-15T00:00:00.000Z',
        })
        .returning({ id: impact_referral_conversions.id });
      if (!conversion) throw new Error('seed conversion missing');
      await db.insert(impact_referral_reward_decisions).values({
        product: ImpactReferralProduct.KiloPass,
        conversion_id: conversion.id,
        beneficiary_user_id: referrer.id,
        beneficiary_role: ImpactReferralBeneficiaryRole.Referrer,
        outcome: ImpactReferralDecisionOutcome.Granted,
        reward_kind: ImpactReferralRewardKind.KiloPassBonus,
        months_granted: 0,
      });
    }
    await insertTouch({ userId: referee.id, type: 'referral', referralCode });
    const subscriptionId = await insertKiloPassSubscription({ userId: referee.id });
    const invoiceId = `inv_${randomUUID()}`;

    const first = await processInvoice({ refereeId: referee.id, subscriptionId, invoiceId });
    const second = await processPersonalKiloPassStripePaidConversion({
      userId: referee.id,
      kiloPassSubscriptionId: subscriptionId,
      sourcePaymentId: invoiceId,
      orderId: invoiceId,
      amount: 49,
      currencyCode: 'usd',
      itemCategory: 'kilo-pass-tier-49-monthly',
      itemName: 'Kilo Pass Tier 49 Monthly',
      sourceTier: KiloPassTier.Tier49,
      cadence: KiloPassCadence.Monthly,
      convertedAt: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(second.conversionId).toBe(first.conversionId);
    const decisions = await db
      .select()
      .from(impact_referral_reward_decisions)
      .where(eq(impact_referral_reward_decisions.conversion_id, first.conversionId ?? ''));
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          beneficiary_role: ImpactReferralBeneficiaryRole.Referee,
          outcome: ImpactReferralDecisionOutcome.Granted,
        }),
        expect.objectContaining({
          beneficiary_role: ImpactReferralBeneficiaryRole.Referrer,
          outcome: ImpactReferralDecisionOutcome.CapLimited,
        }),
      ])
    );
    const rewards = await db
      .select()
      .from(impact_referral_rewards)
      .where(eq(impact_referral_rewards.conversion_id, first.conversionId ?? ''));
    expect(rewards).toHaveLength(1);
    expect(rewards[0]?.beneficiary_user_id).toBe(referee.id);
    expect(mockSendImpactConversionPayload).toHaveBeenCalledTimes(1);
  });

  test('missing configuration fails closed and Impact network failures leave retryable reports', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
    const missingConfigReferee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const referralCode = await insertParticipant(referrer.id);
    await insertTouch({ userId: missingConfigReferee.id, type: 'referral', referralCode });
    const missingConfigSubscriptionId = await insertKiloPassSubscription({
      userId: missingConfigReferee.id,
    });
    mockIsImpactAdvocateConfigured.mockReturnValue(false);

    const missingConfigDisposition = await processInvoice({
      refereeId: missingConfigReferee.id,
      subscriptionId: missingConfigSubscriptionId,
    });

    expect(missingConfigDisposition.disqualificationReason).toBe('referral_missing_configuration');
    expect(await db.select().from(impact_referral_rewards)).toHaveLength(0);
    const failedReport = await db.query.impact_conversion_reports.findFirst({
      where: eq(
        impact_conversion_reports.conversion_id,
        missingConfigDisposition.conversionId ?? ''
      ),
    });
    expect(failedReport?.state).toBe(ImpactConversionReportState.Failed);
    consoleErrorSpy.mockRestore();

    await cleanupDbForTest();
    mockIsImpactAdvocateConfigured.mockReturnValue(true);
    mockSendImpactConversionPayload.mockResolvedValue({
      ok: false,
      failureKind: 'network',
      error: 'network down',
    });
    const retryReferrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
    const retryReferee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const retryReferralCode = await insertParticipant(retryReferrer.id);
    await insertTouch({
      userId: retryReferee.id,
      type: 'referral',
      referralCode: retryReferralCode,
    });
    const retrySubscriptionId = await insertKiloPassSubscription({ userId: retryReferee.id });

    const retryDisposition = await processInvoice({
      refereeId: retryReferee.id,
      subscriptionId: retrySubscriptionId,
    });

    const retryReport = await db.query.impact_conversion_reports.findFirst({
      where: eq(impact_conversion_reports.conversion_id, retryDisposition.conversionId ?? ''),
    });
    expect(retryReport?.state).toBe(ImpactConversionReportState.Retrying);
    expect(await db.select().from(impact_referral_rewards)).toHaveLength(2);
  });

  test('redemption dispatcher backfills missing Kilo Pass reward redemption rows', async () => {
    const { rewardIds } = await seedKiloPassReferralRewardsForAdversePayment({
      statuses: [ImpactReferralRewardStatus.Pending, ImpactReferralRewardStatus.Earned],
    });

    expect(await db.select().from(impact_advocate_reward_redemptions)).toHaveLength(0);

    const summary = await dispatchQueuedImpactAdvocateRewardRedemptions();

    expect(summary).toEqual({ claimed: 2, redeemed: 2, retried: 0, failed: 0 });
    const redemptions = await db.select().from(impact_advocate_reward_redemptions);
    expect(redemptions).toEqual(
      expect.arrayContaining(
        rewardIds.map(rewardId =>
          expect.objectContaining({
            reward_id: rewardId,
            state: 'redeemed',
            request_payload: expect.objectContaining({
              programKey: ImpactAdvocateProgramKey.KiloPass,
              redemption: { amount: 24.5, unit: 'Kilo Pass Bonus Credits' },
            }),
          })
        )
      )
    );
  });

  test('expires stale pending and earned Kilo Pass referral rewards independently of issuance', async () => {
    const { rewardIds } = await seedKiloPassReferralRewardsForAdversePayment({
      statuses: [ImpactReferralRewardStatus.Pending, ImpactReferralRewardStatus.Earned],
    });
    await db
      .update(impact_referral_rewards)
      .set({ expires_at: '2026-01-02T00:00:00.000Z' })
      .where(eq(impact_referral_rewards.id, rewardIds[0] ?? ''));
    await db
      .update(impact_referral_rewards)
      .set({ expires_at: '2026-01-02T00:00:00.000Z' })
      .where(eq(impact_referral_rewards.id, rewardIds[1] ?? ''));

    const firstSummary = await expirePendingKiloPassReferralRewards({
      now: new Date('2026-01-03T00:00:00.000Z'),
    });
    const retrySummary = await expirePendingKiloPassReferralRewards({
      now: new Date('2026-01-03T00:00:00.000Z'),
    });

    expect(firstSummary).toEqual({ expiredRewards: 2 });
    expect(retrySummary).toEqual({ expiredRewards: 0 });
    const rewards = await db
      .select({
        status: impact_referral_rewards.status,
        reviewReason: impact_referral_rewards.review_reason,
        reversedAt: impact_referral_rewards.reversed_at,
      })
      .from(impact_referral_rewards);
    expect(
      rewards.map(reward => ({
        ...reward,
        reversedAt: new Date(reward.reversedAt ?? '').toISOString(),
      }))
    ).toEqual([
      {
        status: ImpactReferralRewardStatus.Expired,
        reviewReason: 'expired_kilo_pass_referral_reward',
        reversedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        status: ImpactReferralRewardStatus.Expired,
        reviewReason: 'expired_kilo_pass_referral_reward',
        reversedAt: '2026-01-03T00:00:00.000Z',
      },
    ]);
  });

  test('adverse Stripe payment cancels pending and earned Kilo Pass referral rewards idempotently', async () => {
    const { invoiceId, conversionId } = await seedKiloPassReferralRewardsForAdversePayment({
      statuses: [ImpactReferralRewardStatus.Pending, ImpactReferralRewardStatus.Earned],
    });

    const firstSummary = await markPersonalKiloPassReferralPaymentAdverse({
      sourcePaymentId: invoiceId,
      reason: 'refund',
      occurredAt: new Date('2026-01-10T00:00:00.000Z'),
    });

    expect(firstSummary).toEqual({
      conversionId,
      canceledRewards: 2,
      reviewRequiredRewards: 0,
    });
    const rewardsAfterFirst = await db
      .select({
        status: impact_referral_rewards.status,
        reviewReason: impact_referral_rewards.review_reason,
        reversedAt: impact_referral_rewards.reversed_at,
      })
      .from(impact_referral_rewards)
      .where(eq(impact_referral_rewards.conversion_id, conversionId));
    expect(
      rewardsAfterFirst.map(reward => ({
        ...reward,
        reversedAt: new Date(reward.reversedAt ?? '').toISOString(),
      }))
    ).toEqual([
      {
        status: ImpactReferralRewardStatus.Canceled,
        reviewReason: 'referral_payment_refund',
        reversedAt: '2026-01-10T00:00:00.000Z',
      },
      {
        status: ImpactReferralRewardStatus.Canceled,
        reviewReason: 'referral_payment_refund',
        reversedAt: '2026-01-10T00:00:00.000Z',
      },
    ]);

    const retrySummary = await markPersonalKiloPassReferralPaymentAdverse({
      sourcePaymentId: invoiceId,
      reason: 'refund',
      occurredAt: new Date('2026-01-10T00:00:00.000Z'),
    });

    expect(retrySummary).toEqual({
      conversionId,
      canceledRewards: 0,
      reviewRequiredRewards: 0,
    });
  });

  test('adverse Stripe dispute moves applied Kilo Pass referral rewards to support review without clawback', async () => {
    const { invoiceId, conversionId, rewardIds } =
      await seedKiloPassReferralRewardsForAdversePayment({
        statuses: [ImpactReferralRewardStatus.Applied],
      });

    const summary = await markPersonalKiloPassReferralPaymentAdverse({
      sourcePaymentId: invoiceId,
      reason: 'chargeback',
      occurredAt: new Date('2026-01-12T00:00:00.000Z'),
    });

    expect(summary).toEqual({
      conversionId,
      canceledRewards: 0,
      reviewRequiredRewards: 1,
    });
    const reward = await db.query.impact_referral_rewards.findFirst({
      where: eq(impact_referral_rewards.id, rewardIds[0] ?? ''),
    });
    expect(reward).toEqual(
      expect.objectContaining({
        status: ImpactReferralRewardStatus.ReviewRequired,
        review_reason: 'referral_payment_chargeback',
      })
    );
    expect(new Date(reward?.reversed_at ?? '').toISOString()).toBe('2026-01-12T00:00:00.000Z');
    expect(new Date(reward?.applied_at ?? '').toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  test('Kilo Pass adverse payment lookup is scoped to Stripe invoice conversion identity', async () => {
    await seedKiloPassReferralRewardsForAdversePayment({
      invoiceId: 'shared-payment-id',
      statuses: [ImpactReferralRewardStatus.Pending],
    });
    const otherUser = await insertTestUser();
    const [creditsConversion] = await db
      .insert(impact_referral_conversions)
      .values({
        product: ImpactReferralProduct.KiloPass,
        referee_user_id: otherUser.id,
        winning_touch_type: ImpactReferralWinningTouchType.Referral,
        payment_provider: ImpactReferralPaymentProvider.Credits,
        source_payment_id: 'shared-payment-id',
        qualified: true,
        converted_at: '2026-01-03T00:00:00.000Z',
      })
      .returning({ id: impact_referral_conversions.id });

    const summary = await markPersonalKiloPassReferralPaymentAdverse({
      sourcePaymentId: 'shared-payment-id',
      reason: 'fraud',
      occurredAt: new Date('2026-01-14T00:00:00.000Z'),
    });

    expect(summary.conversionId).not.toBe(creditsConversion?.id);
    const rewards = await db.select().from(impact_referral_rewards);
    expect(rewards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: ImpactReferralRewardStatus.Canceled,
          review_reason: 'referral_payment_fraud',
        }),
      ])
    );
  });

  test('annual invoices are ineligible for referral rewards', async () => {
    const referrer = await insertTestUser({ created_at: '2025-12-01T00:00:00.000Z' });
    const referee = await insertTestUser({ created_at: '2026-01-02T00:00:00.000Z' });
    const referralCode = await insertParticipant(referrer.id);
    await insertTouch({ userId: referee.id, type: 'referral', referralCode });
    const subscriptionId = await insertKiloPassSubscription({
      userId: referee.id,
      cadence: KiloPassCadence.Yearly,
    });

    const disposition = await processInvoice({
      refereeId: referee.id,
      subscriptionId,
      cadence: KiloPassCadence.Yearly,
      amount: 588,
    });

    expect(disposition.disqualificationReason).toBe('referral_non_monthly_kilo_pass_subscription');
    expect(
      await db
        .select()
        .from(impact_referral_rewards)
        .where(eq(impact_referral_rewards.conversion_id, disposition.conversionId ?? ''))
    ).toHaveLength(0);
  });
});
