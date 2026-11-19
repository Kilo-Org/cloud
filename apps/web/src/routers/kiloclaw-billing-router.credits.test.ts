import {
  createCallerForUser,
  createKiloclawInstance,
  insertPersonalSubscriptionFixture,
  kiloclawInternalClientMock,
  stripeMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kilocode_users,
  kilo_pass_store_purchases,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { sandboxIdFromUserId } from '@kilocode/worker-utils/sandbox-id';
import type Stripe from 'stripe';
import {
  KiloPassTier,
  KiloPassCadence,
  KiloPassPaymentProvider,
} from '@kilocode/web-shared/lib/kilo-pass/enums';
import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';

// ── Credit Enrollment ──────────────────────────────────────────────────────

describe('reprovisionAndEnrollWithCredits', () => {
  async function createInstance(userId: string) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: userId,
        sandbox_id: sandboxIdFromUserId(userId),
      })
      .returning();
    return instance;
  }

  it('does not reprovision a destroyed canceled Standard subscription', async () => {
    const destroyedInstance = await createInstance(user.id);
    await db
      .update(kiloclaw_instances)
      .set({ destroyed_at: '2026-06-30T00:00:00.000Z' })
      .where(eq(kiloclaw_instances.id, destroyedInstance.id));
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: destroyedInstance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.getBillingStatus()).resolves.toMatchObject({
      creditReprovisionRecovery: { eligible: false },
    });
    await expect(
      caller.kiloclaw.reprovisionAndEnrollWithCredits({ plan: 'standard' })
    ).rejects.toThrow('Credit-funded reprovision recovery is not available');
    expect(kiloclawInternalClientMock.__provisionMock).not.toHaveBeenCalled();
  });
});

// ── Billing Status with Credits ────────────────────────────────────────────

describe('getBillingStatus with credits', () => {
  async function createKiloPassSubscription(params: {
    userId: string;
    status: Stripe.Subscription.Status;
    cancelAtPeriodEnd?: boolean;
    endedAt?: string | null;
    paymentProvider?: KiloPassPaymentProvider;
    providerSubscriptionId?: string | null;
  }) {
    const paymentProvider = params.paymentProvider ?? KiloPassPaymentProvider.Stripe;
    const stripeSubscriptionId =
      paymentProvider === KiloPassPaymentProvider.Stripe
        ? (params.providerSubscriptionId ?? `kp-stripe-sub-${crypto.randomUUID()}`)
        : null;
    const providerSubscriptionId =
      paymentProvider === KiloPassPaymentProvider.Stripe
        ? stripeSubscriptionId
        : (params.providerSubscriptionId ?? null);
    const [subscription] = await db
      .insert(kilo_pass_subscriptions)
      .values({
        kilo_user_id: params.userId,
        payment_provider: paymentProvider,
        provider_subscription_id: providerSubscriptionId,
        stripe_subscription_id: stripeSubscriptionId,
        tier: KiloPassTier.Tier19,
        cadence: KiloPassCadence.Monthly,
        status: params.status,
        cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
        started_at: new Date().toISOString(),
        ended_at: params.endedAt ?? null,
        current_streak_months: 1,
        next_yearly_issue_at: null,
      })
      .returning({ id: kilo_pass_subscriptions.id });

    if (!subscription) {
      throw new Error('Failed to create Kilo Pass subscription');
    }

    return subscription;
  }

  it('includes hasStripeFunding=true for Stripe-funded subscription', async () => {
    await insertPersonalSubscriptionFixture({
      stripe_subscription_id: 'sub_stripe_funded',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.hasStripeFunding).toBe(true);
  });

  it('includes hasStripeFunding=false for pure credit subscription', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
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
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.hasStripeFunding).toBe(false);
  });

  it('includes credit balance in response', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(typeof result.creditBalanceMicrodollars).toBe('number');
  });

  it('reports pure credit subscription data (not suppressed)', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
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
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).not.toBeNull();
    expect(result.subscription!.plan).toBe('standard');
    expect(result.subscription!.status).toBe('active');
    expect(result.subscription!.paymentSource).toBe('credits');
    expect(result.subscription!.creditRenewalAt).not.toBeNull();
    expect(result.subscription!.renewalCostMicrodollars).toBe(9_000_000);
  });

  it('reports live legacy subscription economics from the row price version', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      credit_renewal_at: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).toMatchObject({
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      selfServiceInstanceType: 'perf-1-3',
      renewalCostMicrodollars: 9_000_000,
    });
  });

  it('reports live current subscription economics from the row price version', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'commit',
      status: 'active',
      current_period_start: '2026-05-10T00:00:00.000Z',
      current_period_end: '2026-11-10T00:00:00.000Z',
      credit_renewal_at: '2026-11-10T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).toMatchObject({
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      selfServiceInstanceType: 'perf-1-3',
      renewalCostMicrodollars: 306_000_000,
    });
  });

  it('reports fresh current signup economics after canceled legacy history', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `test-sandbox-${Math.random()}`,
        destroyed_at: '2026-05-01T00:00:00.000Z',
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).toMatchObject({
      creditIntroEligible: false,
      intendedPriceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      intendedSelfServiceInstanceType: 'perf-1-3',
      creditEnrollmentPreview: {
        standard: { costMicrodollars: 55_000_000 },
        commit: { costMicrodollars: 306_000_000 },
      },
    });
  });

  it('reports pure-credit renewal date, amount, and local renewal source', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-05-10T00:00:00.000Z',
      current_period_end: '2026-06-10T00:00:00.000Z',
      credit_renewal_at: '2026-06-10T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.subscription).toMatchObject({
      hasStripeFunding: false,
      creditRenewalAt: '2026-06-10T00:00:00.000Z',
      renewalCostMicrodollars: 55_000_000,
      renewalCostSource: 'credit_renewal',
    });
  });

  it('uses Stripe funding indicator for hybrid conversion prompt, portal, and renewal source', async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://stripe.example.test/hybrid-portal',
    });
    await createKiloPassSubscription({ userId: user.id, status: 'active' });
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_hybrid_status',
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-05-10T00:00:00.000Z',
      current_period_end: '2026-06-10T00:00:00.000Z',
      credit_renewal_at: '2026-06-10T00:00:00.000Z',
      cancel_at_period_end: false,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const status = await caller.kiloclaw.getBillingStatus();
    const portal = await caller.kiloclaw.getCustomerPortalUrl({
      instanceId: instance.id,
    });

    expect(status.subscription).toMatchObject({
      paymentSource: 'credits',
      hasStripeFunding: true,
      showConversionPrompt: true,
      creditRenewalAt: '2026-06-10T00:00:00.000Z',
      renewalCostMicrodollars: 55_000_000,
      renewalCostSource: 'stripe_approximation',
    });
    expect(portal).toEqual({
      url: 'https://stripe.example.test/hybrid-portal',
    });
  });

  it('reports creditIntroEligible=true for new user with no subscription', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(true);
  });

  it('reports creditIntroEligible=true for trialing user', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(true);
  });

  it('reports creditIntroEligible=false for returning subscriber', async () => {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: `test-sandbox-${Math.random()}` })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'canceled',
      cancel_at_period_end: false,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditIntroEligible).toBe(false);
  });

  it('reports hasActiveKiloPass=true for a non-ended Kilo Pass subscription', async () => {
    await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(true);
  });

  it('reports hasActiveKiloPass=false for an ended Kilo Pass subscription', async () => {
    await createKiloPassSubscription({
      userId: user.id,
      status: 'canceled',
      endedAt: new Date().toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(false);
  });

  it('reports hasActiveKiloPass=false for an active App Store subscription whose latest purchase expired', async () => {
    const providerSubscriptionId = 'orig_kiloclaw_app_store_expired';
    const subscription = await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
    });

    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscription.id,
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      product_id: 'kilo_pass_tier_19_monthly',
      provider_subscription_id: providerSubscriptionId,
      provider_transaction_id: 'tx_kiloclaw_app_store_expired',
      provider_original_transaction_id: providerSubscriptionId,
      app_account_token: user.app_store_account_token,
      environment: 'Sandbox',
      purchased_at: '2020-01-31T00:00:00.000Z',
      expires_at: '2020-02-28T00:00:00.000Z',
      raw_payload_json: {},
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(false);
  });

  it('reports hasActiveKiloPass=true for an active App Store subscription whose latest purchase has not expired', async () => {
    const providerSubscriptionId = 'orig_kiloclaw_app_store_future_expiry';
    const subscription = await createKiloPassSubscription({
      userId: user.id,
      status: 'active',
      paymentProvider: KiloPassPaymentProvider.AppStore,
      providerSubscriptionId,
    });

    await db.insert(kilo_pass_store_purchases).values({
      kilo_pass_subscription_id: subscription.id,
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      product_id: 'kilo_pass_tier_19_monthly',
      provider_subscription_id: providerSubscriptionId,
      provider_transaction_id: 'tx_kiloclaw_app_store_future_expiry',
      provider_original_transaction_id: providerSubscriptionId,
      app_account_token: user.app_store_account_token,
      environment: 'Sandbox',
      purchased_at: '2099-02-01T00:00:00.000Z',
      expires_at: '2099-03-01T00:00:00.000Z',
      raw_payload_json: {},
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasActiveKiloPass).toBe(true);
  });

  it('includes detached canonical history in the personal billing summary', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      plan: 'standard',
      status: 'active',
      payment_source: 'credits',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getPersonalBillingSummary();

    expect(result.hasExistingPersonalSubscription).toBe(true);
    expect(result.hasCurrentPersonalSubscription).toBe(true);
    expect(result.hasActiveInstance).toBe(false);
  });

  it('reports legacy recurring Standard upsell cost when prior paid history removes intro eligibility', async () => {
    const trialInstance = await createKiloclawInstance(user.id);
    const canceledPaidInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        instance_id: trialInstance.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date().toISOString(),
        trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      },
      {
        user_id: user.id,
        instance_id: canceledPaidInstance.id,
        plan: 'standard',
        status: 'canceled',
        payment_source: 'credits',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getPersonalBillingSummary();

    expect(result.kiloPassUpsellPreview.standard.monthly['19']).toEqual(
      expect.objectContaining({
        eligible: true,
        costMicrodollars: 9_000_000,
        projectedKiloPassBaseMicrodollars: 19_000_000,
        shortfallMicrodollars: 0,
      })
    );
    expect(result.kiloPassUpsellPreview.commit.monthly['49']).toEqual(
      expect.objectContaining({
        eligible: true,
        costMicrodollars: 48_000_000,
        shortfallMicrodollars: 0,
      })
    );
  });

  it('includes Kilo Pass upsell preview data for versioned first charges and shortfalls', async () => {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 4_000_000,
        microdollars_used: 0,
        kilo_pass_threshold: null,
      })
      .where(eq(kilocode_users.id, user.id));

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getPersonalBillingSummary();

    expect(result.kiloPassUpsellPreview.standard.monthly['49']).toEqual({
      eligible: true,
      costMicrodollars: 55_000_000,
      projectedKiloPassBaseMicrodollars: 49_000_000,
      projectedKiloPassBonusMicrodollars: 2_450_000,
      effectiveBalanceMicrodollars: 55_450_000,
      shortfallMicrodollars: 0,
    });
    expect(result.kiloPassUpsellPreview.commit.yearly['199']).toEqual({
      eligible: false,
      costMicrodollars: 306_000_000,
      projectedKiloPassBaseMicrodollars: 199_000_000,
      projectedKiloPassBonusMicrodollars: 99_500_000,
      effectiveBalanceMicrodollars: 302_500_000,
      shortfallMicrodollars: 3_500_000,
    });
  });

  it('includes plan-specific effective balance previews with projected Kilo Pass bonus', async () => {
    await db
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: 0,
        microdollars_used: 0,
        kilo_pass_threshold: 4_000_000,
      })
      .where(eq(kilocode_users.id, user.id));

    const stripeSubscriptionId = `kp-stripe-sub-${crypto.randomUUID()}`;
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      provider_subscription_id: stripeSubscriptionId,
      stripe_subscription_id: stripeSubscriptionId,
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Yearly,
      status: 'active',
      cancel_at_period_end: false,
      started_at: new Date().toISOString(),
      current_streak_months: 1,
      next_yearly_issue_at: null,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.creditEnrollmentPreview.standard.costMicrodollars).toBe(55_000_000);
    expect(result.creditEnrollmentPreview.standard.projectedKiloPassBonusMicrodollars).toBe(
      9_500_000
    );
    expect(result.creditEnrollmentPreview.standard.effectiveBalanceMicrodollars).toBe(9_500_000);

    expect(result.creditEnrollmentPreview.commit.costMicrodollars).toBe(306_000_000);
    expect(result.creditEnrollmentPreview.commit.projectedKiloPassBonusMicrodollars).toBe(
      9_500_000
    );
    expect(result.creditEnrollmentPreview.commit.effectiveBalanceMicrodollars).toBe(9_500_000);
  });
});
