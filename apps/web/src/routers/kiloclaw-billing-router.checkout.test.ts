import {
  PRE_COMMIT_CUTOFF_TIME,
  createCallerForUser,
  createCanceledTrialAndPaidSubscriptions,
  createKiloclawInstance,
  makeStripeSubscription,
  setTestSystemTime,
  stripeMock,
  stripePriceIdsMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it, beforeAll, jest } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kilocode_users,
  credit_transactions,
  kilo_pass_subscriptions,
  user_affiliate_attributions,
  inference_reservations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { sandboxIdFromUserId } from '@kilocode/worker-utils/sandbox-id';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import type Stripe from 'stripe';
import { KiloPassTier, KiloPassCadence } from '@kilocode/web-shared/lib/kilo-pass/enums';
import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  releaseInferenceCredits,
  reserveInferenceCredits,
} from '@kilocode/db/inference-reservations';

describe('createSubscriptionCheckout', () => {
  it('rejects Commit checkout at the retirement cutoff and directs to Standard', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'setInterval',
        'setImmediate',
        'clearTimeout',
        'clearInterval',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    jest.setSystemTime(new Date('2026-06-06T00:00:00.000Z'));
    await createKiloclawInstance(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'commit' })).rejects.toThrow(
      'Commit is no longer available. Choose Standard for month-to-month KiloClaw hosting.'
    );
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects post-cutoff direct credit enrollment and legacy/per-instance plan switches', async () => {
    setTestSystemTime('2026-06-06T00:00:00.000Z');
    const enrollmentInstance = await createKiloclawInstance(user.id);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.enrollWithCredits({
        plan: 'commit',
        instanceId: enrollmentInstance.id,
      })
    ).rejects.toThrow('Commit is no longer available');

    const switchInstance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: switchInstance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-06-01T00:00:00.000Z',
      current_period_end: '2026-07-01T00:00:00.000Z',
      credit_renewal_at: '2026-07-01T00:00:00.000Z',
    });
    await expect(caller.kiloclaw.switchPlan({ toPlan: 'commit' })).rejects.toThrow(
      'Commit is no longer available'
    );
    await expect(
      caller.kiloclaw.switchPlanAtInstance({
        instanceId: switchInstance.id,
        toPlan: 'commit',
      })
    ).rejects.toThrow('Commit is no longer available');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, switchInstance.id));
    expect(row.scheduled_plan).toBeNull();
  });

  it('rejects checkout for an active orphan instance before provider access', async () => {
    await createKiloclawInstance(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'A current KiloClaw subscription is required to provision an instance.'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('uses the current recurring standard price for a live current-price trial', async () => {
    stripePriceIdsMock.getStripePriceIdForClawPlan.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}`
    );
    stripePriceIdsMock.getStripePriceIdForClawPlanIntro.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}_intro`
    );

    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.line_items).toEqual([
      { price: `${CURRENT_KILOCLAW_PRICE_VERSION}_standard`, quantity: 1 },
    ]);
    expect(callArgs.allow_promotion_codes).toBe(true);
    expect(callArgs.discounts).toBeUndefined();
    expect(callArgs.metadata).toEqual(
      expect.objectContaining({
        instanceId: instance.id,
      })
    );
  });

  it('uses the legacy intro price and allows promotion codes for live legacy trials', async () => {
    stripePriceIdsMock.getStripePriceIdForClawPlan.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}`
    );
    stripePriceIdsMock.getStripePriceIdForClawPlanIntro.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}_intro`
    );

    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.line_items).toEqual([
      { price: `${LEGACY_KILOCLAW_PRICE_VERSION}_standard_intro`, quantity: 1 },
    ]);
    expect(callArgs.allow_promotion_codes).toBe(true);
    expect(callArgs.discounts).toBeUndefined();
    expect(callArgs.metadata).toEqual(
      expect.objectContaining({
        instanceId: instance.id,
      })
    );
  });

  it('rejects direct Stripe checkout for canceled legacy lineage before provider access', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      stripe_subscription_id: 'sub_deleted_returning_standard',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'This KiloClaw lineage cannot accept a new Stripe subscription. Activate hosting with credits or reprovision first.'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();

    const [unchangedSubscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
    expect(unchangedSubscription).toEqual(
      expect.objectContaining({
        status: 'canceled',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
        stripe_subscription_id: 'sub_deleted_returning_standard',
      })
    );
  });

  it('rejects direct Stripe checkout for a destroyed billing anchor before provider access', async () => {
    const instance = await createKiloclawInstance(user.id, '2026-06-10T15:01:00.000Z');
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'Reprovision KiloClaw before starting a new Stripe subscription.'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('uses the current recurring standard price after canceled trial history', async () => {
    stripePriceIdsMock.getStripePriceIdForClawPlan.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}`
    );
    stripePriceIdsMock.getStripePriceIdForClawPlanIntro.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}_intro`
    );

    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'canceled',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.line_items).toEqual([
      { price: `${CURRENT_KILOCLAW_PRICE_VERSION}_standard`, quantity: 1 },
    ]);
  });

  it('allows promotion codes for commit plan', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'commit' });

    const callArgs = stripeMock.checkout.sessions.create.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(callArgs.allow_promotion_codes).toBe(true);
    expect(callArgs.discounts).toBeUndefined();
  });

  it('includes affiliateTrackingId in checkout metadata when attribution exists', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    await db.insert(user_affiliate_attributions).values({
      user_id: user.id,
      provider: 'impact',
      tracking_id: 'impact-click-123',
    });

    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: {
          metadata: {
            type: 'kiloclaw',
            billingContext: 'personal',
            plan: 'standard',
            kiloUserId: user.id,
            kiloclawPriceVersion: '2026-03-19',
            affiliateTrackingId: 'impact-click-123',
            instanceId: instance.id,
          },
        },
        metadata: {
          type: 'kiloclaw',
          billingContext: 'personal',
          plan: 'standard',
          kiloUserId: user.id,
          kiloclawPriceVersion: '2026-03-19',
          affiliateTrackingId: 'impact-click-123',
          instanceId: instance.id,
        },
      })
    );
  });
});

describe('createKiloPassUpsellCheckout', () => {
  it('expires a generic checkout before creating an upsell checkout with hosting intent', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });
    const createdSessions: Record<string, unknown>[] = [];
    stripeMock.checkout.sessions.create.mockImplementation(async input => {
      const session = {
        id: `cs_shared_kilo_pass_${createdSessions.length + 1}`,
        status: 'open',
        url: 'https://checkout.stripe.com/shared',
        metadata: input.metadata,
      };
      createdSessions.push(session);
      return session;
    });
    stripeMock.checkout.sessions.list.mockImplementation(async () => ({
      data: createdSessions,
      has_more: false,
    }));

    const caller = await createCallerForUser(user.id);
    const genericResult = await caller.kiloPass.createCheckoutSession({
      tier: 'tier_19',
      cadence: 'monthly',
    });
    const upsellResult = await caller.kiloclaw.createKiloPassUpsellCheckout({
      instanceId: instance.id,
      tier: '19',
      cadence: 'monthly',
      hostingPlan: 'standard',
    });

    expect(genericResult).toEqual({ url: 'https://checkout.stripe.com/shared' });
    expect(upsellResult).toEqual({ url: 'https://checkout.stripe.com/shared' });
    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith('cs_shared_kilo_pass_1', {
      timeout: 10_000,
    });
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledTimes(2);
  });

  it('rejects Commit hosting intent after the cutoff before creating Kilo Pass checkout', async () => {
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'setInterval',
        'setImmediate',
        'clearTimeout',
        'clearInterval',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
      ],
    });
    jest.setSystemTime(new Date('2026-06-06T00:00:00.001Z'));
    const instance = await createKiloclawInstance(user.id);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '199',
        cadence: 'yearly',
        hostingPlan: 'commit',
      })
    ).rejects.toThrow(
      'Commit is no longer available. Choose Standard for month-to-month KiloClaw hosting.'
    );
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects Kilo Pass hosting activation without an existing personal subscription', async () => {
    const instance = await createKiloclawInstance(user.id);
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '199',
        cadence: 'yearly',
        hostingPlan: 'standard',
      })
    ).rejects.toThrow('A current KiloClaw subscription is required to provision an instance.');

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects current Standard hosting when the selected Kilo Pass tier cannot cover the first charge', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '49',
        cadence: 'monthly',
        hostingPlan: 'standard',
      })
    ).rejects.toThrow(
      'Selected Kilo Pass option cannot auto-activate Standard hosting. Choose a larger tier or add credits first.'
    );

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects commit hosting for monthly tier 19', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
    });
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '19',
        cadence: 'monthly',
        hostingPlan: 'commit',
      })
    ).rejects.toThrow(
      'Selected Kilo Pass option does not include enough credits for commit hosting.'
    );

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects commit hosting for yearly tier 19 when monthly effective credits cannot cover the charge', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
    });
    const caller = await createCallerForUser(user.id);

    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '19',
        cadence: 'yearly',
        hostingPlan: 'commit',
      })
    ).rejects.toThrow(
      'Selected Kilo Pass option does not include enough credits for commit hosting.'
    );

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('allows legacy Standard intro hosting for monthly tier 19', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '19',
        cadence: 'monthly',
        hostingPlan: 'standard',
      })
    ).resolves.toEqual({ url: 'https://checkout.stripe.com/test' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });

  it('rejects Kilo Pass hosting checkout for a destroyed billing anchor before provider access', async () => {
    const instance = await createKiloclawInstance(user.id, '2026-06-10T15:01:00.000Z');
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '199',
        cadence: 'monthly',
        hostingPlan: 'standard',
      })
    ).rejects.toThrow('Reprovision KiloClaw before starting Kilo Pass hosting activation.');

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects canceled legacy Kilo Pass hosting before provider checkout', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      stripe_subscription_id: 'sub_deleted_legacy_kilo_pass_intent',
    });
    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '199',
        cadence: 'monthly',
        hostingPlan: 'standard',
      })
    ).rejects.toThrow('Reprovision KiloClaw before purchasing Kilo Pass with bundled hosting.');

    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
    const [unchangedSubscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
    expect(unchangedSubscription).toEqual(
      expect.objectContaining({
        status: 'canceled',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
        stripe_subscription_id: 'sub_deleted_legacy_kilo_pass_intent',
      })
    );
  });

  it('uses empty affiliateTrackingId in Kilo Pass upsell metadata when attribution is absent', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createKiloPassUpsellCheckout({
      instanceId: instance.id,
      tier: '19',
      cadence: 'monthly',
      hostingPlan: 'standard',
    });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: {
          metadata: expect.objectContaining({
            type: 'kilo-pass',
            kiloUserId: user.id,
            tier: 'tier_19',
            cadence: 'monthly',
            affiliateTrackingId: '',
          }),
        },
        metadata: expect.objectContaining({
          type: 'kilo-pass',
          kiloUserId: user.id,
          tier: 'tier_19',
          cadence: 'monthly',
          affiliateTrackingId: '',
        }),
      }),
      { timeout: 10_000 }
    );
  });

  it('includes affiliateTrackingId in Kilo Pass upsell metadata when attribution exists', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });
    await db.insert(user_affiliate_attributions).values({
      user_id: user.id,
      provider: 'impact',
      tracking_id: 'impact-click-123',
    });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.createKiloPassUpsellCheckout({
      instanceId: instance.id,
      tier: '19',
      cadence: 'monthly',
      hostingPlan: 'standard',
    });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: {
          metadata: expect.objectContaining({
            type: 'kilo-pass',
            kiloUserId: user.id,
            tier: 'tier_19',
            cadence: 'monthly',
            affiliateTrackingId: 'impact-click-123',
          }),
        },
        metadata: expect.objectContaining({
          type: 'kilo-pass',
          kiloUserId: user.id,
          tier: 'tier_19',
          cadence: 'monthly',
          affiliateTrackingId: 'impact-click-123',
        }),
      }),
      { timeout: 10_000 }
    );
  });

  it('excludes inference holds from Kilo Pass upsell previews and checkout eligibility', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 5_000_000, microdollars_used: 1_000_000 })
      .where(eq(kilocode_users.id, user.id));
    const reservation = {
      requestId: crypto.randomUUID(),
      userId: user.id,
      amountMicrodollars: 1_000_000,
    };

    try {
      expect(await reserveInferenceCredits(db, reservation)).toMatchObject({ kind: 'reserved' });
      const caller = await createCallerForUser(user.id);
      const billing = await caller.kiloclaw.getPersonalBillingSummary();
      expect(billing.creditBalanceMicrodollars).toBe(3_000_000);
      expect(billing.kiloPassUpsellPreview.standard.monthly['49']).toEqual({
        eligible: false,
        costMicrodollars: 55_000_000,
        projectedKiloPassBaseMicrodollars: 49_000_000,
        projectedKiloPassBonusMicrodollars: 2_450_000,
        effectiveBalanceMicrodollars: 54_450_000,
        shortfallMicrodollars: 550_000,
      });
      await expect(
        caller.kiloclaw.createKiloPassUpsellCheckout({
          instanceId: instance.id,
          tier: '49',
          cadence: 'monthly',
          hostingPlan: 'standard',
        })
      ).rejects.toThrow(
        'Selected Kilo Pass option cannot auto-activate Standard hosting. Choose a larger tier or add credits first.'
      );
      expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();

      await db.transaction(tx => releaseInferenceCredits(tx, reservation));
      const refreshedCaller = await createCallerForUser(user.id);
      const refreshedBilling = await refreshedCaller.kiloclaw.getPersonalBillingSummary();
      expect(refreshedBilling.kiloPassUpsellPreview.standard.monthly['49']).toMatchObject({
        eligible: true,
        projectedKiloPassBonusMicrodollars: 2_450_000,
        effectiveBalanceMicrodollars: 55_450_000,
        shortfallMicrodollars: 0,
      });
    } finally {
      await db.transaction(tx => releaseInferenceCredits(tx, reservation));
      await db
        .delete(inference_reservations)
        .where(eq(inference_reservations.request_id, reservation.requestId));
    }
  });

  it('allows current Standard hosting when balance plus selected tier projection covers the first charge', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 4_000_000 })
      .where(eq(kilocode_users.id, user.id));
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '49',
        cadence: 'monthly',
        hostingPlan: 'standard',
      })
    ).resolves.toEqual({ url: 'https://checkout.stripe.com/test' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });

  it('allows legacy Commit hosting for monthly tier 49', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '49',
        cadence: 'monthly',
        hostingPlan: 'commit',
      })
    ).resolves.toEqual({ url: 'https://checkout.stripe.com/test' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });

  it('allows current Commit hosting only when balance plus selected tier projection covers the six-month charge', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 8_000_000 })
      .where(eq(kilocode_users.id, user.id));
    stripeMock.checkout.sessions.create.mockResolvedValue({
      url: 'https://checkout.stripe.com/test',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.createKiloPassUpsellCheckout({
        instanceId: instance.id,
        tier: '199',
        cadence: 'yearly',
        hostingPlan: 'commit',
      })
    ).resolves.toEqual({ url: 'https://checkout.stripe.com/test' });

    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });
});

describe('current-price canceled Stripe checkout webhook ordering', () => {
  let handleKiloClawSubscriptionCreated: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;
  let handleKiloClawInvoicePaid: (params: {
    eventId: string;
    invoice: Stripe.Invoice;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionCreated = mod.handleKiloClawSubscriptionCreated;
    handleKiloClawInvoicePaid = mod.handleKiloClawInvoicePaid;
  });

  it.each(['subscription.created before invoice.paid', 'invoice.paid before subscription.created'])(
    'settles safely when %s',
    async order => {
      const orderKey = order.startsWith('subscription.created') ? 'created_first' : 'invoice_first';
      const instance = await createKiloclawInstance(user.id);
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        instance_id: instance.id,
        stripe_subscription_id: `sub_deleted_old_${orderKey}`,
        payment_source: 'credits',
        plan: 'standard',
        status: 'canceled',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      });

      const stripeSubscriptionId = `sub_current_rejoin_${orderKey}`;
      const subscription = makeStripeSubscription({
        id: stripeSubscriptionId,
        metadata: {
          type: 'kiloclaw',
          billingContext: 'personal',
          plan: 'standard',
          kiloUserId: user.id,
          instanceId: instance.id,
          kiloclawPriceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        },
        status: 'active',
        priceId: 'price_current_standard',
      });
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        ...subscription,
        schedule: null,
      });
      const invoice = {
        id: `in_current_rejoin_${orderKey}`,
        amount_paid: 5_500,
        currency: 'usd',
        charge: `ch_current_rejoin_${orderKey}`,
        parent: {
          subscription_details: {
            subscription: stripeSubscriptionId,
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_current_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-06-10T15:03:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-07-10T15:03:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
      } as unknown as Stripe.Invoice;

      if (order.startsWith('subscription.created')) {
        await handleKiloClawSubscriptionCreated({
          eventId: `evt_created_${orderKey}`,
          subscription,
        });
        await handleKiloClawInvoicePaid({
          eventId: `evt_invoice_${orderKey}`,
          invoice,
        });
      } else {
        await handleKiloClawInvoicePaid({
          eventId: `evt_invoice_${orderKey}`,
          invoice,
        });
        await handleKiloClawSubscriptionCreated({
          eventId: `evt_created_${orderKey}`,
          subscription,
        });
      }

      const [row] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
      expect(row).toEqual(
        expect.objectContaining({
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
          stripe_subscription_id: stripeSubscriptionId,
        })
      );

      const settlementEntries = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.kilo_user_id, user.id));
      expect(
        settlementEntries.map(entry => entry.amount_microdollars).sort((a, b) => a - b)
      ).toEqual([-55_000_000, 55_000_000]);
    }
  );
});

describe('createSubscriptionCheckout — concurrent checkout guard', () => {
  it('expires stale open checkout sessions and creates a new one', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [
        {
          id: 'cs_existing',
          metadata: { type: 'kiloclaw', instanceId: instance.id },
        },
      ],
    });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_new',
      url: 'https://checkout.stripe.com/new',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.createSubscriptionCheckout({
      plan: 'standard',
    });

    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith('cs_existing');
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
    expect(result).toEqual({ url: 'https://checkout.stripe.com/new' });
  });

  it('swallows expire errors (session already expired or completed)', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({
      data: [
        {
          id: 'cs_gone',
          metadata: { type: 'kiloclaw', instanceId: instance.id },
        },
      ],
    });
    stripeMock.checkout.sessions.expire.mockRejectedValue(new Error('session no longer open'));
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_new',
      url: 'https://checkout.stripe.com/new',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.createSubscriptionCheckout({
      plan: 'standard',
    });

    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith('cs_gone');
    expect(result).toEqual({ url: 'https://checkout.stripe.com/new' });
  });

  it('rejects when an active Stripe subscription already exists', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const activeSub = makeStripeSubscription({
      id: 'sub_stripe_active',
      metadata: { type: 'kiloclaw', instanceId: instance.id },
      status: 'active',
      priceId: 'price_standard',
    });

    stripeMock.subscriptions.list
      .mockResolvedValueOnce({ data: [activeSub] }) // active query
      .mockResolvedValueOnce({ data: [] }); // trialing query
    stripeMock.checkout.sessions.list.mockResolvedValue({ data: [] });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );
  });

  it('rejects when a canceled trial and an active paid subscription both exist locally', async () => {
    await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_checkout_blocked',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects when a canceled trial and a past-due paid subscription both exist locally', async () => {
    await createCanceledTrialAndPaidSubscriptions({
      paidStatus: 'past_due',
      paidStripeSubscriptionId: 'sub_checkout_past_due',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rejects when a canceled trial and an unpaid paid subscription both exist locally', async () => {
    await createCanceledTrialAndPaidSubscriptions({
      paidStatus: 'unpaid',
      paidStripeSubscriptionId: 'sub_checkout_unpaid',
    });

    const caller = await createCallerForUser(user.id);

    await expect(caller.kiloclaw.createSubscriptionCheckout({ plan: 'standard' })).rejects.toThrow(
      'You already have an active subscription'
    );

    expect(stripeMock.subscriptions.list).not.toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('does not block personal checkout when only an org-backed subscription is active', async () => {
    const organization = await createOrganization('Org Checkout Test', user.id);
    const orgInstance = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning()
      .then(rows => rows[0]!);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: orgInstance.id,
      stripe_subscription_id: 'sub_org_active',
      plan: 'standard',
      status: 'active',
    });

    const personalInstance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: personalInstance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    stripeMock.subscriptions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.list.mockResolvedValue({ data: [] });
    stripeMock.checkout.sessions.create.mockResolvedValue({
      id: 'cs_personal',
      url: 'https://checkout.stripe.com/personal',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.createSubscriptionCheckout({
      plan: 'standard',
    });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/personal' });
    expect(stripeMock.checkout.sessions.create).toHaveBeenCalled();
  });
});

describe('acceptConversion', () => {
  async function createActiveKiloPass(userId: string) {
    const stripeSubscriptionId = `kp-stripe-sub-${crypto.randomUUID()}`;
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: userId,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });
  }

  it('sets cancel_at_period_end on Stripe-funded subscription when user has active Kilo Pass', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_convert',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.acceptConversion();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_convert', {
      cancel_at_period_end: true,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    expect(row.pending_conversion).toBe(true);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, row.id));
    expect(logs).toHaveLength(2);
    expect(logs.map(log => `${log.action}:${log.reason}`).sort()).toEqual([
      'canceled:user_requested_conversion',
      'status_changed:user_requested_conversion_prepare',
    ]);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor_type: 'user',
          actor_id: user.id,
          action: 'status_changed',
          reason: 'user_requested_conversion_prepare',
          before_state: expect.objectContaining({
            pending_conversion: false,
            cancel_at_period_end: false,
          }),
          after_state: expect.objectContaining({
            pending_conversion: true,
            cancel_at_period_end: false,
          }),
        }),
        expect.objectContaining({
          actor_type: 'user',
          actor_id: user.id,
          action: 'canceled',
          reason: 'user_requested_conversion',
          before_state: expect.objectContaining({
            pending_conversion: true,
            cancel_at_period_end: false,
          }),
          after_state: expect.objectContaining({
            pending_conversion: true,
            cancel_at_period_end: true,
          }),
        }),
      ])
    );
  });

  it('releases schedule before setting cancel_at_period_end', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_convert_sched',
      plan: 'commit',
      status: 'active',
      stripe_schedule_id: 'sched_conv',
      scheduled_plan: 'standard',
      scheduled_by: 'user',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.acceptConversion();

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith('sched_conv');

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.cancel_at_period_end).toBe(true);
    expect(row.stripe_schedule_id).toBeNull();
    expect(row.scheduled_plan).toBeNull();
  });

  it('rejects when no active Kilo Pass', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_no_kp',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow('Active Kilo Pass required');
  });

  it('rejects when subscription is not Stripe-funded', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    await createActiveKiloPass(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow('not Stripe-funded');
  });

  it('rejects when subscription is already set to cancel', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_already_cancel',
      plan: 'standard',
      status: 'active',
      cancel_at_period_end: true,
    });
    await createActiveKiloPass(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow('already set to cancel');
  });

  it('rolls back pending_conversion when Stripe definitively rejects the update', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_stripe_reject',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ schedule: null });
    stripeMock.subscriptions.update.mockRejectedValue(new Error('Stripe API error'));
    // Re-fetch confirms Stripe did NOT apply cancel_at_period_end
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow(
      'Failed to schedule Stripe cancellation'
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.pending_conversion).toBe(false);
    expect(row.cancel_at_period_end).toBe(false);
  });

  it('keeps pending_conversion when Stripe update throws but re-fetch confirms cancellation applied', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_stripe_timeout',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ schedule: null });
    stripeMock.subscriptions.update.mockRejectedValue(new Error('Stripe timeout'));
    // Re-fetch confirms Stripe DID apply cancel_at_period_end (timeout-after-commit)
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({
      cancel_at_period_end: true,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.acceptConversion();

    expect(result).toEqual({ success: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.pending_conversion).toBe(true);
    expect(row.cancel_at_period_end).toBe(true);
  });

  it('throws on ambiguous failure but leaves pending_conversion armed for retry safety', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_stripe_double_fail',
      plan: 'standard',
      status: 'active',
    });
    await createActiveKiloPass(user.id);

    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({ schedule: null });
    stripeMock.subscriptions.update.mockRejectedValue(new Error('Stripe timeout'));
    // Re-fetch also fails — ambiguous state
    stripeMock.subscriptions.retrieve.mockRejectedValueOnce(new Error('Stripe unavailable'));

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.acceptConversion()).rejects.toThrow(
      'Unable to confirm Stripe cancellation'
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    // pending_conversion stays armed (Stripe may have committed)
    expect(row.pending_conversion).toBe(true);
    // cancel_at_period_end is NOT set — allows retry
    expect(row.cancel_at_period_end).toBe(false);
  });
});
