import { credit_transactions, impact_attribution_touches } from '@kilocode/db/schema';
import {
  ImpactAttributionTouchProvider,
  ImpactAttributionTouchType,
} from '@kilocode/db/schema-types';

import { getSeedDb } from '../lib/db';
import type { SeedResult } from '../index';
import {
  assertUserCount,
  cleanupKiloClawReferralSeedScenario,
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

const SCENARIO = 'referrals-support-override';
const SEED_SCOPE = `kiloclaw/${SCENARIO}`;
const referrerUserId = seedUserId(SCENARIO, 'referrer');
const refereeUserId = seedUserId(SCENARIO, 'referee');
const userIds = [referrerUserId, refereeUserId];
const referrerEmail = seedEmail(SCENARIO, 'referrer');
const refereeEmail = seedEmail(SCENARIO, 'referee');
const opaqueReferralIdentifier = seedOpaqueReferralIdentifier(SCENARIO, 'primary');
const sourcePaymentId = seedSourcePaymentId(SCENARIO, 'manual-adjustment');
const orderId = seedOrderId(SCENARIO, 'manual-adjustment');
const convertedAt = '2026-04-15T16:30:00.000Z';

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
      name: 'Seed Support Override Referrer',
    },
    {
      id: refereeUserId,
      email: refereeEmail,
      name: 'Seed Support Override Referee',
    },
  ]);
  await assertUserCount({ userIds, expectedCount: 2 });

  console.log(`[${SEED_SCOPE}] Inserting active personal subscriptions for both users`);
  const { subscription: referrerSubscription } = await insertPersonalSubscription({
    userId: referrerUserId,
    sandboxId: `sandbox-${referrerUserId}`,
    name: 'Seed Support Override Referrer',
    plan: 'standard',
    status: 'active',
    paymentSource: 'credits',
    currentPeriodStart: '2026-04-01T00:00:00.000Z',
    currentPeriodEnd: '2026-05-01T00:00:00.000Z',
    creditRenewalAt: '2026-05-01T00:00:00.000Z',
  });
  const { subscription: refereeSubscription } = await insertPersonalSubscription({
    userId: refereeUserId,
    sandboxId: `sandbox-${refereeUserId}`,
    name: 'Seed Support Override Referee',
    plan: 'standard',
    status: 'active',
    paymentSource: 'credits',
    currentPeriodStart: '2026-04-01T00:00:00.000Z',
    currentPeriodEnd: '2026-05-01T00:00:00.000Z',
    creditRenewalAt: '2026-05-01T00:00:00.000Z',
  });

  console.log(
    `[${SEED_SCOPE}] Inserting the referrer participant and a valid referral touch on the referee`
  );
  await insertImpactAdvocateParticipant({
    userId: referrerUserId,
    email: referrerEmail,
    opaqueReferralIdentifier,
    registeredAt: '2026-04-01T12:00:00.000Z',
  });

  const [affiliateTouch] = await db
    .insert(impact_attribution_touches)
    .values({
      dedupe_key: `${seedLabelForScenario(SCENARIO)}:touch:affiliate`,
      user_id: refereeUserId,
      touch_type: ImpactAttributionTouchType.Affiliate,
      provider: ImpactAttributionTouchProvider.ImpactPerformance,
      opaque_tracking_value: `${seedLabelForScenario(SCENARIO)}:im-ref`,
      tracking_value_length: 50,
      is_tracking_value_accepted: true,
      im_ref: `${seedLabelForScenario(SCENARIO)}:im-ref`,
      landing_path: '/pricing?im_ref=seed',
      touched_at: '2026-04-10T12:00:00.000Z',
      expires_at: '2026-05-10T12:00:00.000Z',
    })
    .returning({ id: impact_attribution_touches.id });

  const [referralTouch] = await db
    .insert(impact_attribution_touches)
    .values({
      dedupe_key: `${seedLabelForScenario(SCENARIO)}:touch:referral`,
      user_id: refereeUserId,
      touch_type: ImpactAttributionTouchType.Referral,
      provider: ImpactAttributionTouchProvider.ImpactAdvocate,
      opaque_tracking_value: `${seedLabelForScenario(SCENARIO)}:cookie`,
      tracking_value_length: 48,
      is_tracking_value_accepted: true,
      rs_code: opaqueReferralIdentifier,
      rs_share_medium: 'support',
      rs_engagement_medium: 'manual',
      landing_path: '/pricing?_saasquatch=seed',
      touched_at: '2026-04-11T09:00:00.000Z',
      expires_at: '2026-05-11T09:00:00.000Z',
    })
    .returning({ id: impact_attribution_touches.id });

  console.log(
    `[${SEED_SCOPE}] Inserting a manual-adjustment payment record ready for admin override processing`
  );
  await db.insert(credit_transactions).values({
    kilo_user_id: refereeUserId,
    amount_microdollars: -2000000,
    is_free: false,
    description: 'Manual seed adjustment for referral override verification',
    credit_category: sourcePaymentId,
    created_at: convertedAt,
  });

  console.log('');
  console.log('This fixture represents:');
  console.log('- a valid referral touch that would normally win over the affiliate touch');
  console.log('- a source payment that heuristically looks like a manual adjustment');
  console.log('- no conversion rows yet, so an authorized operator can test the override flow');
  console.log('');
  console.log('Suggested next step (requires an authenticated admin session):');
  console.log(
    `  curl -X POST http://localhost:3000/admin/api/users/${refereeUserId}/kiloclaw-referral-eligibility \\\n    -H 'content-type: application/json' \\\n    --data '${JSON.stringify(
      {
        sourcePaymentId,
        orderId,
        amount: 20,
        currencyCode: 'USD',
        itemCategory: 'kiloclaw_subscription',
        itemName: 'KiloClaw Standard',
        convertedAt,
        sourceType: 'manual_adjustment',
      }
    )}'`
  );

  return {
    referrerUserId,
    refereeUserId,
    referrerSubscriptionId: referrerSubscription.id,
    refereeSubscriptionId: refereeSubscription.id,
    affiliateTouchId: affiliateTouch.id,
    referralTouchId: referralTouch.id,
    sourcePaymentId,
    orderId,
  };
}
