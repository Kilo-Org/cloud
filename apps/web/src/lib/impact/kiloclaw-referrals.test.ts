import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

jest.mock('@/lib/impact', () => {
  const actual = jest.requireActual('@/lib/impact');
  return {
    ...actual,
    isImpactConfigured: jest.fn(() => true),
    sendImpactConversionPayload: jest.fn(async () => ({ ok: true, delivery: 'accepted' })),
    reverseImpactAction: jest.fn(async () => ({ ok: true, delivery: 'accepted' })),
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
      responseBody: JSON.stringify({ rewards: [{ id: 'impact-reward-123', type: 'CREDIT' }] }),
      rewards: [{ id: 'impact-reward-123', type: 'CREDIT' }],
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

import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  impact_advocate_participants,
  impact_advocate_reward_redemptions,
  impact_conversion_reports,
  impact_attribution_touches,
  kiloclaw_instances,
  impact_referral_conversions,
  impact_referral_reward_applications,
  impact_referral_reward_decisions,
  impact_referral_rewards,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  kilocode_users,
  referral_codes,
  user_affiliate_attributions,
  type ImpactAttributionTouch,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  dispatchQueuedImpactAdvocateRewardRedemptions,
  markPersonalKiloClawReferralPaymentAdverse,
  processPersonalKiloClawPaidConversion,
  processQueuedKiloClawReferralRewards,
  resolveWinningAttributionTouch,
} from '@/lib/impact/kiloclaw-referrals';
import { isImpactConfigured, reverseImpactAction, sendImpactConversionPayload } from '@/lib/impact';
import {
  isImpactAdvocateConfigured,
  sendImpactAdvocateRewardLookupPayload,
  sendImpactAdvocateRewardRedemptionPayload,
} from '@/lib/impact/advocate';
import { client as stripeClient } from '@/lib/stripe-client';
import { ImpactReferralPaymentProvider } from '@kilocode/db/schema-types';

const mockIsImpactConfigured = jest.mocked(isImpactConfigured);
const mockIsImpactAdvocateConfigured = jest.mocked(isImpactAdvocateConfigured);
const mockSendImpactConversionPayload = jest.mocked(sendImpactConversionPayload);
const mockSendImpactAdvocateRewardLookupPayload = jest.mocked(
  sendImpactAdvocateRewardLookupPayload
);
const mockSendImpactAdvocateRewardRedemptionPayload = jest.mocked(
  sendImpactAdvocateRewardRedemptionPayload
);
const mockReverseImpactAction = jest.mocked(reverseImpactAction);
const mockStripeSubscriptionUpdate = jest.mocked(stripeClient.subscriptions.update);

function makeTouch(
  overrides: Partial<ImpactAttributionTouch> & Pick<ImpactAttributionTouch, 'touch_type'>
): ImpactAttributionTouch {
  const touchedAt = overrides.touched_at ?? '2026-04-01T00:00:00.000Z';
  return {
    id: overrides.id ?? randomUUID(),
    product: overrides.product ?? 'kiloclaw',
    program_key: overrides.program_key ?? 'kiloclaw',
    dedupe_key: overrides.dedupe_key ?? randomUUID(),
    anonymous_id: overrides.anonymous_id ?? null,
    user_id: overrides.user_id ?? 'user_123',
    touch_type: overrides.touch_type,
    provider:
      overrides.provider ??
      (overrides.touch_type === 'referral' ? 'impact_advocate' : 'impact_performance'),
    opaque_tracking_value: overrides.opaque_tracking_value ?? 'opaque-value',
    tracking_value_length: overrides.tracking_value_length ?? 12,
    is_tracking_value_accepted: overrides.is_tracking_value_accepted ?? true,
    rs_code: overrides.rs_code ?? null,
    rs_share_medium: overrides.rs_share_medium ?? null,
    rs_engagement_medium: overrides.rs_engagement_medium ?? null,
    im_ref: overrides.im_ref ?? null,
    landing_path: overrides.landing_path ?? null,
    utm_source: overrides.utm_source ?? null,
    utm_medium: overrides.utm_medium ?? null,
    utm_campaign: overrides.utm_campaign ?? null,
    utm_term: overrides.utm_term ?? null,
    utm_content: overrides.utm_content ?? null,
    touched_at: touchedAt,
    expires_at: overrides.expires_at ?? '2026-05-01T00:00:00.000Z',
    sale_attributed_at: overrides.sale_attributed_at ?? null,
    created_at: overrides.created_at ?? touchedAt,
  };
}

async function insertActivePersonalSubscription(
  userId: string,
  overrides?: Partial<typeof kiloclaw_subscriptions.$inferInsert> & {
    organizationId?: string | null;
  }
): Promise<{ subscriptionId: string; instanceId: string }> {
  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: `sandbox-${userId}`,
      organization_id: overrides?.organizationId ?? null,
    })
    .returning({ id: kiloclaw_instances.id });

  const [subscription] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: userId,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T12:00:00.000Z',
      credit_renewal_at: '2026-05-01T12:00:00.000Z',
      cancel_at_period_end: false,
      ...overrides,
    })
    .returning({ id: kiloclaw_subscriptions.id });

  return {
    subscriptionId: subscription.id,
    instanceId: instance.id,
  };
}

async function insertImpactAdvocateParticipant(userId: string, opaqueReferralIdentifier?: string) {
  const identifier = opaqueReferralIdentifier ?? randomUUID();
  await db.insert(impact_advocate_participants).values({
    user_id: userId,
    advocate_id: userId,
    advocate_account_id: userId,
    opaque_referral_identifier: identifier,
    contact_email: `${userId}@example.com`,
    registration_state: 'registered',
    registered_at: '2026-03-01T00:00:00.000Z',
  });
  return identifier;
}

async function insertAppliedReferralRewardForUser(userId: string): Promise<string> {
  const [conversion] = await db
    .insert(impact_referral_conversions)
    .values({
      referee_user_id: userId,
      referrer_user_id: null,
      winning_touch_type: 'none',
      source_payment_id: `reward-redemption-test:${randomUUID()}`,
      qualified: true,
      converted_at: '2026-04-10T00:00:00.000Z',
    })
    .returning({ id: impact_referral_conversions.id });

  if (!conversion) throw new Error('Failed to insert referral conversion');

  const [decision] = await db
    .insert(impact_referral_reward_decisions)
    .values({
      conversion_id: conversion.id,
      beneficiary_user_id: userId,
      beneficiary_role: 'referee',
      outcome: 'granted',
      months_granted: 1,
    })
    .returning({ id: impact_referral_reward_decisions.id });

  if (!decision) throw new Error('Failed to insert referral reward decision');

  const [reward] = await db
    .insert(impact_referral_rewards)
    .values({
      conversion_id: conversion.id,
      decision_id: decision.id,
      beneficiary_user_id: userId,
      beneficiary_role: 'referee',
      months_granted: 1,
      status: 'applied',
      earned_at: '2026-04-10T00:00:00.000Z',
      applied_at: '2026-04-10T00:05:00.000Z',
    })
    .returning({ id: impact_referral_rewards.id });

  if (!reward) throw new Error('Failed to insert referral reward');

  return reward.id;
}

describe('kiloclaw referrals', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    mockIsImpactConfigured.mockReturnValue(true);
    mockIsImpactAdvocateConfigured.mockReturnValue(true);
    mockSendImpactAdvocateRewardLookupPayload.mockResolvedValue({
      ok: true,
      statusCode: 200,
      responseBody: JSON.stringify({ rewards: [{ id: 'impact-reward-123', type: 'CREDIT' }] }),
      rewards: [{ id: 'impact-reward-123', type: 'CREDIT' }],
    });
    mockSendImpactAdvocateRewardRedemptionPayload.mockResolvedValue({
      ok: true,
      statusCode: 200,
      responseBody: '{}',
    });
    await db.delete(impact_conversion_reports).where(sql`true`);
    await db.delete(impact_advocate_reward_redemptions).where(sql`true`);
    await db.delete(impact_referral_reward_applications).where(sql`true`);
    await db.delete(impact_referral_rewards).where(sql`true`);
    await db.delete(impact_referral_reward_decisions).where(sql`true`);
    await db.delete(impact_referral_conversions).where(sql`true`);
    await db.delete(user_affiliate_attributions).where(sql`true`);
    await db.delete(impact_attribution_touches).where(sql`true`);
    await db.delete(credit_transactions).where(sql`true`);
    await db.delete(kiloclaw_subscription_change_log).where(sql`true`);
    await db.delete(kiloclaw_subscriptions).where(sql`true`);
    await db.delete(kiloclaw_instances).where(sql`true`);
    await db.delete(impact_advocate_participants).where(sql`true`);
    await db.delete(referral_codes).where(sql`true`);
    await db.delete(kilocode_users).where(sql`true`);
  });

  describe('dispatchQueuedImpactAdvocateRewardRedemptions', () => {
    it('does not treat already-redeemed Impact responses as success before this row has selected the reward', async () => {
      const user = await insertTestUser({
        google_user_email: 'first-already-redeemed@example.com',
        normalized_email: 'first-already-redeemed@example.com',
      });
      const rewardId = await insertAppliedReferralRewardForUser(user.id);
      await db.insert(impact_advocate_reward_redemptions).values({
        reward_id: rewardId,
        dedupe_key: `first-already-redeemed:${rewardId}`,
        beneficiary_user_id: user.id,
        state: 'queued',
        request_payload: {
          lookup: {
            accountId: user.google_user_email,
            userId: user.google_user_email,
            rewardTypeFilter: 'CREDIT',
          },
          redemption: { amount: 1, unit: 'MONTH' },
        },
      });
      mockSendImpactAdvocateRewardRedemptionPayload.mockResolvedValueOnce({
        ok: false,
        failureKind: 'http_4xx',
        statusCode: 400,
        responseBody: 'Reward already redeemed',
      });

      const summary = await dispatchQueuedImpactAdvocateRewardRedemptions();

      expect(summary).toEqual({ claimed: 1, redeemed: 0, retried: 0, failed: 1 });
      const [redemption] = await db.select().from(impact_advocate_reward_redemptions);
      expect(redemption).toEqual(
        expect.objectContaining({
          state: 'failed',
          impact_reward_id: 'impact-reward-123',
          response_status_code: 400,
        })
      );
    });

    it('treats already-redeemed Impact responses as idempotent success for a previously selected reward', async () => {
      const user = await insertTestUser({
        google_user_email: 'retry-already-redeemed@example.com',
        normalized_email: 'retry-already-redeemed@example.com',
      });
      const rewardId = await insertAppliedReferralRewardForUser(user.id);
      await db.insert(impact_advocate_reward_redemptions).values({
        reward_id: rewardId,
        dedupe_key: `retry-already-redeemed:${rewardId}`,
        beneficiary_user_id: user.id,
        state: 'queued',
        impact_reward_id: 'impact-reward-123',
        request_payload: {
          lookup: {
            accountId: user.google_user_email,
            userId: user.google_user_email,
            rewardTypeFilter: 'CREDIT',
          },
          redemption: { amount: 1, unit: 'MONTH' },
        },
      });
      mockSendImpactAdvocateRewardRedemptionPayload.mockResolvedValueOnce({
        ok: false,
        failureKind: 'http_4xx',
        statusCode: 400,
        responseBody: 'Reward already redeemed',
      });

      const summary = await dispatchQueuedImpactAdvocateRewardRedemptions();

      expect(summary).toEqual({ claimed: 1, redeemed: 1, retried: 0, failed: 0 });
      const [redemption] = await db.select().from(impact_advocate_reward_redemptions);
      expect(redemption).toEqual(
        expect.objectContaining({
          state: 'redeemed',
          impact_reward_id: 'impact-reward-123',
          response_status_code: 400,
          redeem_response_payload: expect.objectContaining({ alreadyRedeemed: true }),
        })
      );
    });

    it('redeems month credits returned by Impact', async () => {
      const user = await insertTestUser({
        google_user_email: 'month-credit@example.com',
        normalized_email: 'month-credit@example.com',
      });
      const rewardId = await insertAppliedReferralRewardForUser(user.id);
      await db.insert(impact_advocate_reward_redemptions).values({
        reward_id: rewardId,
        dedupe_key: `month-credit:${rewardId}`,
        beneficiary_user_id: user.id,
        state: 'queued',
        request_payload: {
          lookup: {
            accountId: user.google_user_email,
            userId: user.google_user_email,
            rewardTypeFilter: 'CREDIT',
          },
          redemption: { amount: 1, unit: 'MONTH' },
        },
      });
      mockSendImpactAdvocateRewardLookupPayload.mockResolvedValueOnce({
        ok: true,
        statusCode: 200,
        responseBody: JSON.stringify([
          {
            id: 'impact-month-reward',
            type: 'CREDIT',
            unit: 'MONTH',
            assignedCredit: 1,
            redeemedCredit: 0,
          },
        ]),
        rewards: [
          {
            id: 'impact-month-reward',
            type: 'CREDIT',
            unit: 'MONTH',
            assignedCredit: 1,
            redeemedCredit: 0,
          },
        ],
      });

      const summary = await dispatchQueuedImpactAdvocateRewardRedemptions();

      expect(summary).toEqual({ claimed: 1, redeemed: 1, retried: 0, failed: 0 });
      expect(mockSendImpactAdvocateRewardRedemptionPayload).toHaveBeenCalledWith({
        rewardId: 'impact-month-reward',
        amount: 1,
        unit: 'MONTH',
      });
      const [redemption] = await db.select().from(impact_advocate_reward_redemptions);
      expect(redemption).toEqual(
        expect.objectContaining({
          state: 'redeemed',
          impact_reward_id: 'impact-month-reward',
        })
      );
    });
  });

  describe('resolveWinningAttributionTouch', () => {
    const convertedAt = new Date('2026-04-10T00:00:00.000Z');

    it('prefers referral over an unsold affiliate touch', () => {
      const affiliateTouch = makeTouch({
        id: 'affiliate-touch',
        touch_type: 'affiliate',
        touched_at: '2026-04-01T00:00:00.000Z',
        im_ref: 'im-ref',
      });
      const referralTouch = makeTouch({
        id: 'referral-touch',
        touch_type: 'referral',
        touched_at: '2026-04-02T00:00:00.000Z',
        rs_code: 'ref-code',
      });

      expect(
        resolveWinningAttributionTouch({ touches: [affiliateTouch, referralTouch], convertedAt })
      ).toMatchObject({ winner: 'referral', referralTouch: { id: 'referral-touch' } });
    });

    it('preserves affiliate when it had already been sale-attributed before the referral touch', () => {
      const affiliateTouch = makeTouch({
        id: 'affiliate-touch',
        touch_type: 'affiliate',
        touched_at: '2026-04-01T00:00:00.000Z',
        sale_attributed_at: '2026-04-01T12:00:00.000Z',
        im_ref: 'im-ref',
      });
      const referralTouch = makeTouch({
        id: 'referral-touch',
        touch_type: 'referral',
        touched_at: '2026-04-02T00:00:00.000Z',
        rs_code: 'ref-code',
      });

      expect(
        resolveWinningAttributionTouch({ touches: [affiliateTouch, referralTouch], convertedAt })
      ).toMatchObject({ winner: 'affiliate', affiliateTouch: { id: 'affiliate-touch' } });
    });

    it('keeps referral priority when the referral touch happened first', () => {
      const referralTouch = makeTouch({
        id: 'referral-touch',
        touch_type: 'referral',
        touched_at: '2026-04-01T00:00:00.000Z',
        rs_code: 'ref-code',
      });
      const affiliateTouch = makeTouch({
        id: 'affiliate-touch',
        touch_type: 'affiliate',
        touched_at: '2026-04-02T00:00:00.000Z',
        im_ref: 'im-ref',
      });

      expect(
        resolveWinningAttributionTouch({ touches: [affiliateTouch, referralTouch], convertedAt })
      ).toMatchObject({ winner: 'referral', referralTouch: { id: 'referral-touch' } });
    });

    it('falls back to affiliate when no valid referral exists', () => {
      const affiliateTouch = makeTouch({
        id: 'affiliate-touch',
        touch_type: 'affiliate',
        im_ref: 'im-ref',
      });

      expect(
        resolveWinningAttributionTouch({ touches: [affiliateTouch], convertedAt })
      ).toMatchObject({ winner: 'affiliate', affiliateTouch: { id: 'affiliate-touch' } });
    });

    it('falls back to referral when no affiliate exists', () => {
      const referralTouch = makeTouch({
        id: 'referral-touch',
        touch_type: 'referral',
        rs_code: 'ref-code',
      });

      expect(
        resolveWinningAttributionTouch({ touches: [referralTouch], convertedAt })
      ).toMatchObject({ winner: 'referral', referralTouch: { id: 'referral-touch' } });
    });

    it('returns none when all touches are expired or invalid', () => {
      const expiredAffiliateTouch = makeTouch({
        id: 'affiliate-touch',
        touch_type: 'affiliate',
        im_ref: 'im-ref',
        touched_at: '2026-03-01T00:00:00.000Z',
        expires_at: '2026-03-31T00:00:00.000Z',
      });
      const invalidReferralTouch = makeTouch({
        id: 'referral-touch',
        touch_type: 'referral',
        rs_code: 'ref-code',
        opaque_tracking_value: null,
        is_tracking_value_accepted: false,
      });

      expect(
        resolveWinningAttributionTouch({
          touches: [expiredAffiliateTouch, invalidReferralTouch],
          convertedAt,
        })
      ).toEqual({
        winner: 'none',
        affiliateTouch: null,
        referralTouch: null,
      });
    });

    it('filters touches by product for mirrored Kilo Pass attribution', () => {
      const kiloClawReferralTouch = makeTouch({
        id: 'kiloclaw-referral-touch',
        product: 'kiloclaw',
        touch_type: 'referral',
        touched_at: '2026-04-01T00:00:00.000Z',
        rs_code: 'claw-ref-code',
      });
      const kiloPassAffiliateTouch = makeTouch({
        id: 'kilo-pass-affiliate-touch',
        product: 'kilo_pass',
        program_key: null,
        touch_type: 'affiliate',
        touched_at: '2026-04-02T00:00:00.000Z',
        im_ref: 'pass-im-ref',
      });

      expect(
        resolveWinningAttributionTouch({
          product: 'kilo_pass',
          touches: [kiloClawReferralTouch, kiloPassAffiliateTouch],
          convertedAt,
        })
      ).toMatchObject({
        winner: 'affiliate',
        affiliateTouch: { id: 'kilo-pass-affiliate-touch' },
        referralTouch: null,
      });
    });

    it('uses the exact 30-day UTC expiration boundary', () => {
      const referralTouch = makeTouch({
        id: 'boundary-referral-touch',
        touch_type: 'referral',
        touched_at: '2026-04-01T00:00:00.000Z',
        expires_at: '2026-06-01T00:00:00.000Z',
        rs_code: 'ref-code',
      });

      expect(
        resolveWinningAttributionTouch({
          touches: [referralTouch],
          convertedAt: new Date('2026-04-30T23:59:59.999Z'),
        })
      ).toMatchObject({ winner: 'referral' });
      expect(
        resolveWinningAttributionTouch({
          touches: [referralTouch],
          convertedAt: new Date('2026-05-01T00:00:00.000Z'),
        })
      ).toEqual({
        winner: 'none',
        affiliateTouch: null,
        referralTouch: null,
      });
    });
  });

  describe('processPersonalKiloClawPaidConversion', () => {
    it('records affiliate-winning first paid conversions and marks the touch as sale-attributed', async () => {
      const user = await insertTestUser({
        google_user_email: 'affiliate-winner@example.com',
        normalized_email: 'affiliate-winner@example.com',
      });
      const sourcePaymentId = 'kiloclaw-subscription:instance-a:2026-04';

      await insertActivePersonalSubscription(user.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: user.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      const affiliateTouchId = '11111111-1111-4111-8111-111111111111';
      await db.insert(impact_attribution_touches).values({
        id: affiliateTouchId,
        dedupe_key: 'affiliate-touch',
        user_id: user.id,
        touch_type: 'affiliate',
        provider: 'impact_performance',
        opaque_tracking_value: 'im-ref-123',
        tracking_value_length: 10,
        is_tracking_value_accepted: true,
        im_ref: 'im-ref-123',
        touched_at: '2026-04-01T00:00:00.000Z',
        expires_at: '2026-05-01T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: user.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: true,
        winningTouchType: 'affiliate',
        conversionId: expect.any(String),
        disqualificationReason: 'referral_affiliate_won',
      });

      const [touch] = await db
        .select()
        .from(impact_attribution_touches)
        .where(eq(impact_attribution_touches.id, affiliateTouchId));
      expect(touch.sale_attributed_at).toBeTruthy();
      expect(mockSendImpactConversionPayload).not.toHaveBeenCalled();
    });

    it('records referral-winning first paid conversions, grants both sides, and queues impact reporting', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'referrer@example.com',
        normalized_email: 'referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'referee@example.com',
        normalized_email: 'referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-b:2026-04';

      await insertActivePersonalSubscription(referrer.id);
      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '22222222-2222-4222-8222-222222222222',
        dedupe_key: 'referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition.shouldEnqueueAffiliateSale).toBe(false);
      expect(disposition.winningTouchType).toBe('referral');
      expect(disposition.disqualificationReason).toBeNull();

      const decisions = await db
        .select()
        .from(impact_referral_reward_decisions)
        .where(eq(impact_referral_reward_decisions.conversion_id, disposition.conversionId ?? ''));
      expect(decisions).toHaveLength(2);
      expect(decisions.map(decision => decision.outcome).sort()).toEqual(['granted', 'granted']);

      const rewards = await db
        .select()
        .from(impact_referral_rewards)
        .where(eq(impact_referral_rewards.conversion_id, disposition.conversionId ?? ''));
      expect(rewards).toHaveLength(2);
      expect(rewards.map(reward => reward.status).sort()).toEqual(['applied', 'applied']);

      const applications = await db.select().from(impact_referral_reward_applications);
      expect(applications).toHaveLength(2);
      expect(
        applications.map(application => String(application.new_renewal_boundary)).sort()
      ).toEqual(['2026-06-01 12:00:00+00', '2026-06-01 12:00:00+00']);

      const subscriptions = await db
        .select({
          userId: kiloclaw_subscriptions.user_id,
          currentPeriodEnd: kiloclaw_subscriptions.current_period_end,
          creditRenewalAt: kiloclaw_subscriptions.credit_renewal_at,
        })
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.plan, 'standard'));
      expect(subscriptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: referrer.id,
            currentPeriodEnd: '2026-06-01 12:00:00+00',
            creditRenewalAt: '2026-06-01 12:00:00+00',
          }),
          expect.objectContaining({
            userId: referee.id,
            currentPeriodEnd: '2026-06-01 12:00:00+00',
            creditRenewalAt: '2026-06-01 12:00:00+00',
          }),
        ])
      );

      const reports = await db.select().from(impact_conversion_reports);
      expect(reports).toHaveLength(1);
      expect(reports[0].state).toBe('delivered');
      expect(mockSendImpactConversionPayload).toHaveBeenCalledTimes(1);
    });

    it('scopes conversion identity and report dedupe by payment provider', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'provider-scope-referrer@example.com',
        normalized_email: 'provider-scope-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'provider-scope-referee@example.com',
        normalized_email: 'provider-scope-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'shared-source-payment-id';

      await insertActivePersonalSubscription(referrer.id);
      await insertActivePersonalSubscription(referee.id);
      await db.insert(impact_attribution_touches).values({
        id: '33333333-3333-4333-8333-333333333333',
        dedupe_key: 'provider-scope-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      const creditsDisposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        paymentProvider: ImpactReferralPaymentProvider.Credits,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });
      const stripeDisposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        paymentProvider: ImpactReferralPaymentProvider.Stripe,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });
      const repeatCreditsDisposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        paymentProvider: ImpactReferralPaymentProvider.Credits,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(creditsDisposition.conversionId).toEqual(expect.any(String));
      expect(stripeDisposition.conversionId).toEqual(expect.any(String));
      expect(stripeDisposition.conversionId).not.toBe(creditsDisposition.conversionId);
      expect(repeatCreditsDisposition.conversionId).toBe(creditsDisposition.conversionId);

      const conversions = await db
        .select({
          id: impact_referral_conversions.id,
          paymentProvider: impact_referral_conversions.payment_provider,
        })
        .from(impact_referral_conversions)
        .where(eq(impact_referral_conversions.source_payment_id, sourcePaymentId));
      expect(conversions).toHaveLength(2);
      expect(conversions.map(conversion => conversion.paymentProvider).sort()).toEqual([
        ImpactReferralPaymentProvider.Credits,
        ImpactReferralPaymentProvider.Stripe,
      ]);

      const reports = await db
        .select({ dedupeKey: impact_conversion_reports.dedupe_key })
        .from(impact_conversion_reports);
      expect(reports.map(report => report.dedupeKey).sort()).toEqual([
        `impact-referral-sale:kiloclaw:${ImpactReferralPaymentProvider.Credits}:${sourcePaymentId}`,
        `impact-referral-sale:kiloclaw:${ImpactReferralPaymentProvider.Stripe}:${sourcePaymentId}`,
      ]);
    });

    it('resolves referrers through referral_codes when no participant mapping exists', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'referral-code-referrer@example.com',
        normalized_email: 'referral-code-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'referral-code-referee@example.com',
        normalized_email: 'referral-code-referee@example.com',
      });
      const impactReferralId = 'REFERRER5616';
      const sourcePaymentId = 'kiloclaw-subscription:instance-referral-code:2026-04';

      await db.insert(referral_codes).values({
        kilo_user_id: referrer.id,
        code: impactReferralId,
      });
      await insertActivePersonalSubscription(referrer.id);
      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: 'abababab-abab-4bab-8bab-abababababab',
        dedupe_key: 'referral-code-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: impactReferralId,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toMatchObject({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'referral',
        disqualificationReason: null,
      });

      const [conversion] = await db.select().from(impact_referral_conversions);
      expect(conversion.referrer_user_id).toBe(referrer.id);
      expect(conversion.qualified).toBe(true);
    });

    it('allows signup referral touches captured shortly after user creation', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'signup-race-referrer@example.com',
        normalized_email: 'signup-race-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'signup-race-referee@example.com',
        normalized_email: 'signup-race-referee@example.com',
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-01T00:00:00.000Z',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-signup-race:2026-04';

      await insertActivePersonalSubscription(referrer.id);
      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd',
        dedupe_key: 'signup-race-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        landing_path: '/users/after-sign-in?signup=true&callbackPath=%2Fclaw%2Fnew',
        touched_at: '2026-04-01T00:00:02.000Z',
        expires_at: '2026-05-01T00:00:02.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toMatchObject({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'referral',
        disqualificationReason: null,
      });
    });

    it('logs terminal 4xx Impact conversion report failures and stops retrying unchanged payloads', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockSendImpactConversionPayload.mockResolvedValueOnce({
        ok: false,
        failureKind: 'http_4xx',
        statusCode: 400,
        responseBody: 'bad request',
      });

      const referrer = await insertTestUser({
        google_user_email: 'terminal-report-referrer@example.com',
        normalized_email: 'terminal-report-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'terminal-report-referee@example.com',
        normalized_email: 'terminal-report-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-terminal-report:2026-04';

      await insertActivePersonalSubscription(referrer.id);
      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '12121212-1212-4212-8212-121212121212',
        dedupe_key: 'terminal-report-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'referral',
        conversionId: expect.any(String),
        disqualificationReason: null,
      });

      const [report] = await db.select().from(impact_conversion_reports);
      expect(report.state).toBe('failed');
      expect(report.next_retry_at).toBeNull();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[kiloclaw-referrals] Impact conversion report failed permanently',
        expect.objectContaining({
          reportId: report.id,
          conversionId: disposition.conversionId,
          statusCode: 400,
          failureKind: 'http_4xx',
        })
      );
    });

    it('fails closed when reward-bearing referral configuration is missing', async () => {
      mockIsImpactConfigured.mockReturnValue(false);
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        const referrer = await insertTestUser({
          google_user_email: 'config-referrer@example.com',
          normalized_email: 'config-referrer@example.com',
        });
        const referee = await insertTestUser({
          google_user_email: 'config-referee@example.com',
          normalized_email: 'config-referee@example.com',
        });
        const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
        const sourcePaymentId = 'kiloclaw-subscription:instance-config:2026-04';

        await insertActivePersonalSubscription(referrer.id);
        await insertActivePersonalSubscription(referee.id);
        await db.insert(credit_transactions).values({
          kilo_user_id: referee.id,
          amount_microdollars: -9_000_000,
          is_free: false,
          description: 'KiloClaw standard enrollment',
          credit_category: sourcePaymentId,
        });
        await db.insert(impact_attribution_touches).values({
          id: '77777777-7777-4777-8777-777777777777',
          dedupe_key: 'missing-config-referral-touch',
          user_id: referee.id,
          touch_type: 'referral',
          provider: 'impact_advocate',
          opaque_tracking_value: 'sq-cookie',
          tracking_value_length: 9,
          is_tracking_value_accepted: true,
          rs_code: opaqueReferralIdentifier,
          touched_at: '2026-03-31T00:00:00.000Z',
          expires_at: '2026-04-30T00:00:00.000Z',
        });

        const disposition = await processPersonalKiloClawPaidConversion({
          userId: referee.id,
          sourcePaymentId,
          orderId: sourcePaymentId,
          amount: 9,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard',
          itemName: 'KiloClaw Standard Plan',
          itemSku: 'price_standard',
          convertedAt: new Date('2026-04-09T00:00:00.000Z'),
        });

        expect(disposition).toEqual({
          shouldEnqueueAffiliateSale: false,
          winningTouchType: 'referral',
          conversionId: expect.any(String),
          disqualificationReason: 'referral_missing_configuration',
        });

        const decisions = await db
          .select({
            beneficiaryRole: impact_referral_reward_decisions.beneficiary_role,
            outcome: impact_referral_reward_decisions.outcome,
            reason: impact_referral_reward_decisions.reason,
          })
          .from(impact_referral_reward_decisions)
          .where(
            eq(impact_referral_reward_decisions.conversion_id, disposition.conversionId ?? '')
          );
        expect(decisions).toHaveLength(2);
        expect(decisions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              beneficiaryRole: 'referee',
              outcome: 'disqualified',
              reason: 'referral_missing_configuration',
            }),
            expect.objectContaining({
              beneficiaryRole: 'referrer',
              outcome: 'disqualified',
              reason: 'referral_missing_configuration',
            }),
          ])
        );

        const rewards = await db.select().from(impact_referral_rewards);
        expect(rewards).toHaveLength(0);

        const reports = await db.select().from(impact_conversion_reports);
        expect(reports).toHaveLength(1);
        expect(reports[0].state).toBe('failed');
        expect(reports[0].response_payload).toMatchObject({
          error: 'missing_reward_bearing_referral_configuration',
        });
        expect(mockSendImpactConversionPayload).not.toHaveBeenCalled();
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[kiloclaw-referrals] reward-bearing referral configuration is incomplete',
          expect.objectContaining({
            sourcePaymentId,
            userId: referee.id,
            impactPerformanceConfigured: false,
            impactAdvocateConfigured: true,
          })
        );
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('disqualifies referral touches captured after the user already existed', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'old-referrer@example.com',
        normalized_email: 'old-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'existing-referee@example.com',
        normalized_email: 'existing-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-c:2026-04';

      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '33333333-3333-4333-8333-333333333333',
        dedupe_key: 'late-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2030-01-01T00:00:00.000Z',
        expires_at: '2030-02-01T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2030-01-05T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'referral',
        conversionId: expect.any(String),
        disqualificationReason: 'referral_existing_user_before_touch',
      });

      const rewards = await db.select().from(impact_referral_rewards);
      expect(rewards).toHaveLength(0);
      expect(mockSendImpactConversionPayload).not.toHaveBeenCalled();
    });

    it('does not preserve affiliate renewals when no affiliate touch has previously won a sale', async () => {
      const referee = await insertTestUser({
        google_user_email: 'renewal-no-sale-touch@example.com',
        normalized_email: 'renewal-no-sale-touch@example.com',
      });

      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values([
        {
          kilo_user_id: referee.id,
          amount_microdollars: -9_000_000,
          is_free: false,
          description: 'KiloClaw standard enrollment',
          credit_category: 'kiloclaw-subscription:instance-renewal:2026-03',
        },
        {
          kilo_user_id: referee.id,
          amount_microdollars: -9_000_000,
          is_free: false,
          description: 'KiloClaw standard renewal',
          credit_category: 'kiloclaw-subscription:instance-renewal:2026-04',
        },
      ]);
      await db.insert(user_affiliate_attributions).values({
        user_id: referee.id,
        provider: 'impact',
        tracking_id: 'impact-click-123',
      });
      await db.insert(impact_attribution_touches).values({
        id: '88888888-8888-4888-8888-888888888888',
        dedupe_key: 'affiliate-touch-without-sale',
        user_id: referee.id,
        touch_type: 'affiliate',
        provider: 'impact_performance',
        opaque_tracking_value: 'impact-click-123',
        tracking_value_length: 16,
        is_tracking_value_accepted: true,
        im_ref: 'impact-click-123',
        touched_at: '2026-03-01T00:00:00.000Z',
        expires_at: '2026-03-31T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId: 'kiloclaw-subscription:instance-renewal:2026-04',
        orderId: 'kiloclaw-subscription:instance-renewal:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'none',
        conversionId: null,
        disqualificationReason: 'not_first_paid_period',
      });
    });

    it('preserves affiliate renewals when a prior affiliate touch already won the sale', async () => {
      const referee = await insertTestUser({
        google_user_email: 'renewal-sale-touch@example.com',
        normalized_email: 'renewal-sale-touch@example.com',
      });

      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values([
        {
          kilo_user_id: referee.id,
          amount_microdollars: -9_000_000,
          is_free: false,
          description: 'KiloClaw standard enrollment',
          credit_category: 'kiloclaw-subscription:instance-renewal-sale:2026-03',
        },
        {
          kilo_user_id: referee.id,
          amount_microdollars: -9_000_000,
          is_free: false,
          description: 'KiloClaw standard renewal',
          credit_category: 'kiloclaw-subscription:instance-renewal-sale:2026-04',
        },
      ]);
      await db.insert(user_affiliate_attributions).values({
        user_id: referee.id,
        provider: 'impact',
        tracking_id: 'impact-click-456',
      });
      await db.insert(impact_attribution_touches).values({
        id: '99999999-9999-4999-8999-999999999999',
        dedupe_key: 'affiliate-touch-with-sale',
        user_id: referee.id,
        touch_type: 'affiliate',
        provider: 'impact_performance',
        opaque_tracking_value: 'impact-click-456',
        tracking_value_length: 16,
        is_tracking_value_accepted: true,
        im_ref: 'impact-click-456',
        touched_at: '2026-03-01T00:00:00.000Z',
        expires_at: '2026-03-31T00:00:00.000Z',
        sale_attributed_at: '2026-03-05T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId: 'kiloclaw-subscription:instance-renewal-sale:2026-04',
        orderId: 'kiloclaw-subscription:instance-renewal-sale:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: true,
        winningTouchType: 'affiliate',
        conversionId: null,
        disqualificationReason: 'not_first_paid_period',
      });
    });

    it('disqualifies conversions when the user has no current personal KiloClaw subscription', async () => {
      const referee = await insertTestUser({
        google_user_email: 'no-personal-sub@example.com',
        normalized_email: 'no-personal-sub@example.com',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId: 'kiloclaw-subscription:instance-missing:2026-04',
        orderId: 'kiloclaw-subscription:instance-missing:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'none',
        conversionId: null,
        disqualificationReason: 'referral_non_personal_subscription',
      });
    });

    it('disqualifies admin-adjusted subscriptions unless explicitly overridden', async () => {
      const referee = await insertTestUser({
        google_user_email: 'admin-adjusted@example.com',
        normalized_email: 'admin-adjusted@example.com',
      });
      const { subscriptionId } = await insertActivePersonalSubscription(referee.id);
      await db.insert(kiloclaw_subscription_change_log).values({
        subscription_id: subscriptionId,
        actor_type: 'system',
        actor_id: 'admin-test',
        action: 'admin_override',
        reason: 'manual adjustment',
        before_state: null,
        after_state: null,
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId: 'kiloclaw-subscription:instance-admin-adjusted:2026-04',
        orderId: 'kiloclaw-subscription:instance-admin-adjusted:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'none',
        conversionId: null,
        disqualificationReason: 'referral_admin_adjusted_subscription',
      });
    });

    it('disqualifies explicitly flagged test conversions unless an override marks them eligible', async () => {
      const referee = await insertTestUser({
        google_user_email: 'test-flagged@example.com',
        normalized_email: 'test-flagged@example.com',
      });
      await insertActivePersonalSubscription(referee.id);

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId: 'kiloclaw-subscription:instance-test-flagged:2026-04',
        orderId: 'kiloclaw-subscription:instance-test-flagged:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
        qualificationContext: {
          sourceType: 'test',
        },
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: false,
        winningTouchType: 'none',
        conversionId: null,
        disqualificationReason: 'referral_test_subscription',
      });
    });

    it('allows explicitly overridden manual conversions to continue through normal qualification', async () => {
      const referee = await insertTestUser({
        google_user_email: 'override-eligible@example.com',
        normalized_email: 'override-eligible@example.com',
      });
      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: 'kiloclaw-subscription:instance-override-eligible:2026-04',
      });
      await db.insert(impact_attribution_touches).values({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        dedupe_key: 'override-eligible-affiliate-touch',
        user_id: referee.id,
        touch_type: 'affiliate',
        provider: 'impact_performance',
        opaque_tracking_value: 'impact-click-override',
        tracking_value_length: 21,
        is_tracking_value_accepted: true,
        im_ref: 'impact-click-override',
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId: 'kiloclaw-subscription:instance-override-eligible:2026-04',
        orderId: 'kiloclaw-subscription:instance-override-eligible:2026-04',
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
        qualificationContext: {
          sourceType: 'manual_adjustment',
          overrideEligible: true,
        },
      });

      expect(disposition).toEqual({
        shouldEnqueueAffiliateSale: true,
        winningTouchType: 'affiliate',
        conversionId: expect.any(String),
        disqualificationReason: 'referral_affiliate_won',
      });
    });

    it('applies pending referrer rewards after the referrer later starts an eligible subscription', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'pending-referrer@example.com',
        normalized_email: 'pending-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'pending-referee@example.com',
        normalized_email: 'pending-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-d:2026-04';

      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '44444444-4444-4444-8444-444444444444',
        dedupe_key: 'pending-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      const disposition = await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      const rewardsBefore = await db
        .select({
          beneficiaryUserId: impact_referral_rewards.beneficiary_user_id,
          status: impact_referral_rewards.status,
        })
        .from(impact_referral_rewards)
        .where(eq(impact_referral_rewards.conversion_id, disposition.conversionId ?? ''));
      expect(rewardsBefore).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            beneficiaryUserId: referee.id,
            status: 'applied',
          }),
          expect.objectContaining({
            beneficiaryUserId: referrer.id,
            status: 'pending',
          }),
        ])
      );

      await insertActivePersonalSubscription(referrer.id);

      const summary = await processQueuedKiloClawReferralRewards({
        beneficiaryUserIds: [referrer.id],
      });
      expect(summary).toEqual({
        claimed: 1,
        applied: 1,
        expired: 0,
        pending: 0,
        failed: 0,
      });

      const [referrerReward] = await db
        .select()
        .from(impact_referral_rewards)
        .where(eq(impact_referral_rewards.beneficiary_user_id, referrer.id));
      expect(referrerReward.status).toBe('applied');

      const queuedRedemptions = await db.select().from(impact_advocate_reward_redemptions);
      expect(queuedRedemptions).toHaveLength(2);
      expect(queuedRedemptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ beneficiary_user_id: referee.id, state: 'queued' }),
          expect.objectContaining({ beneficiary_user_id: referrer.id, state: 'queued' }),
        ])
      );

      const redemptionSummary = await dispatchQueuedImpactAdvocateRewardRedemptions();
      expect(redemptionSummary).toEqual({ claimed: 2, redeemed: 2, retried: 0, failed: 0 });
      expect(mockSendImpactAdvocateRewardLookupPayload).toHaveBeenCalledTimes(2);
      expect(mockSendImpactAdvocateRewardLookupPayload).toHaveBeenCalledWith({
        accountId: 'pending-referee@example.com',
        userId: 'pending-referee@example.com',
        rewardTypeFilter: 'CREDIT',
      });
      expect(mockSendImpactAdvocateRewardLookupPayload).toHaveBeenCalledWith({
        accountId: 'pending-referrer@example.com',
        userId: 'pending-referrer@example.com',
        rewardTypeFilter: 'CREDIT',
      });
      expect(mockSendImpactAdvocateRewardRedemptionPayload).toHaveBeenCalledTimes(2);
      expect(mockSendImpactAdvocateRewardRedemptionPayload).toHaveBeenCalledWith({
        rewardId: 'impact-reward-123',
        amount: 1,
        unit: 'MONTH',
      });

      const redeemedRedemptions = await db.select().from(impact_advocate_reward_redemptions);
      expect(redeemedRedemptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            beneficiary_user_id: referee.id,
            state: 'redeemed',
            impact_reward_id: 'impact-reward-123',
          }),
          expect.objectContaining({
            beneficiary_user_id: referrer.id,
            state: 'redeemed',
            impact_reward_id: 'impact-reward-123',
          }),
        ])
      );
    });

    it('leaves local reward state unchanged when Stripe reward application fails', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'stripe-failure-referrer@example.com',
        normalized_email: 'stripe-failure-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'stripe-failure-referee@example.com',
        normalized_email: 'stripe-failure-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-stripe-failure:2026-04';

      mockStripeSubscriptionUpdate.mockRejectedValueOnce(new Error('stripe exploded'));

      await insertActivePersonalSubscription(referee.id, {
        stripe_subscription_id: 'sub_referee_failure_123',
      });
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '54545454-5454-4545-8545-545454545454',
        dedupe_key: 'stripe-failure-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      const [subscription] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.user_id, referee.id));
      expect(subscription.current_period_end).toBe('2026-05-01 12:00:00+00');

      const refereeRewards = await db
        .select({
          status: impact_referral_rewards.status,
          appliedAt: impact_referral_rewards.applied_at,
        })
        .from(impact_referral_rewards)
        .where(eq(impact_referral_rewards.beneficiary_user_id, referee.id));
      expect(refereeRewards).toEqual([
        {
          status: 'earned',
          appliedAt: null,
        },
      ]);

      const applications = await db.select().from(impact_referral_reward_applications);
      expect(applications).toHaveLength(0);
    });

    it('keeps stripe-funded reward application in sync with Stripe trial-end billing delays', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'stripe-referrer@example.com',
        normalized_email: 'stripe-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'stripe-referee@example.com',
        normalized_email: 'stripe-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-e:2026-04';

      await insertActivePersonalSubscription(referrer.id);
      await insertActivePersonalSubscription(referee.id, {
        stripe_subscription_id: 'sub_referee_123',
      });
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '55555555-5555-4555-8555-555555555555',
        dedupe_key: 'stripe-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      expect(mockStripeSubscriptionUpdate).toHaveBeenCalledWith(
        'sub_referee_123',
        expect.objectContaining({
          proration_behavior: 'none',
          trial_end: Math.floor(new Date('2026-06-01T12:00:00.000Z').getTime() / 1000),
        }),
        expect.objectContaining({
          idempotencyKey: expect.stringContaining('stripe-apply'),
        })
      );
    });

    it('cancels unapplied rewards and marks applied rewards for review when the qualifying payment is charged back', async () => {
      const referrer = await insertTestUser({
        google_user_email: 'reversal-referrer@example.com',
        normalized_email: 'reversal-referrer@example.com',
      });
      const referee = await insertTestUser({
        google_user_email: 'reversal-referee@example.com',
        normalized_email: 'reversal-referee@example.com',
      });
      const opaqueReferralIdentifier = await insertImpactAdvocateParticipant(referrer.id);
      const sourcePaymentId = 'kiloclaw-subscription:instance-f:2026-04';

      mockSendImpactConversionPayload.mockResolvedValueOnce({
        ok: true,
        delivery: 'immediate',
        actionId: '1000.2000.3000',
        responseBody: '{}',
      });

      await insertActivePersonalSubscription(referee.id);
      await db.insert(credit_transactions).values({
        kilo_user_id: referee.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'KiloClaw standard enrollment',
        credit_category: sourcePaymentId,
      });
      await db.insert(impact_attribution_touches).values({
        id: '66666666-6666-4666-8666-666666666666',
        dedupe_key: 'reversal-referral-touch',
        user_id: referee.id,
        touch_type: 'referral',
        provider: 'impact_advocate',
        opaque_tracking_value: 'sq-cookie',
        tracking_value_length: 9,
        is_tracking_value_accepted: true,
        rs_code: opaqueReferralIdentifier,
        touched_at: '2026-03-31T00:00:00.000Z',
        expires_at: '2026-04-30T00:00:00.000Z',
      });

      await processPersonalKiloClawPaidConversion({
        userId: referee.id,
        sourcePaymentId,
        orderId: sourcePaymentId,
        amount: 9,
        currencyCode: 'usd',
        itemCategory: 'kiloclaw-standard',
        itemName: 'KiloClaw Standard Plan',
        itemSku: 'price_standard',
        convertedAt: new Date('2026-04-09T00:00:00.000Z'),
      });

      const summary = await markPersonalKiloClawReferralPaymentAdverse({
        sourcePaymentId,
        reason: 'chargeback',
        occurredAt: new Date('2026-04-15T00:00:00.000Z'),
      });
      expect(summary).toEqual({
        conversionId: expect.any(String),
        canceledRewards: 1,
        reviewRequiredRewards: 1,
        impactActionReversed: true,
      });

      const rewards = await db
        .select({
          beneficiaryUserId: impact_referral_rewards.beneficiary_user_id,
          status: impact_referral_rewards.status,
          reviewReason: impact_referral_rewards.review_reason,
        })
        .from(impact_referral_rewards);
      expect(rewards).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            beneficiaryUserId: referee.id,
            status: 'review_required',
            reviewReason: 'referral_payment_chargeback',
          }),
          expect.objectContaining({
            beneficiaryUserId: referrer.id,
            status: 'canceled',
            reviewReason: 'referral_payment_chargeback',
          }),
        ])
      );
      expect(mockReverseImpactAction).toHaveBeenCalledWith({ actionId: '1000.2000.3000' });
    });
  });
});
