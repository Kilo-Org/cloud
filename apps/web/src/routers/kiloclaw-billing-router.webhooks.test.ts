import {
  FINAL_COMMIT_END,
  FINAL_COMMIT_START,
  PRE_COMMIT_CUTOFF_TIME,
  createKiloclawInstance,
  insertFinalCommitFixture,
  kiloclawInternalClientMock,
  makeStripeSubscription,
  posthogCaptureMock,
  seedDeliveredImpactSignupEvent,
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
  user_affiliate_events,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { sandboxIdFromUserId } from '@kilocode/worker-utils/sandbox-id';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import type Stripe from 'stripe';
import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';

describe('handleKiloClawSubscriptionUpdated', () => {
  let handleKiloClawSubscriptionUpdated: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionUpdated = mod.handleKiloClawSubscriptionUpdated;
  });

  it('maps Stripe trialing status with commit plan to local active', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_trial',
      plan: 'commit',
      status: 'trialing',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_commit_trial',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'trialing',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_commit_trialing',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.status).toBe('active');
    expect(row.plan).toBe('commit');
  });

  it('maps Stripe trialing status with standard plan to local active', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_standard_trial',
      plan: 'standard',
      status: 'trialing',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_standard_trial',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'trialing',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_standard_trialing',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.status).toBe('active');
    expect(row.plan).toBe('standard');
  });

  it('contains incoming Standard for retirement-involved row without durable consent', async () => {
    const { subscription: existing } = await insertFinalCommitFixture({
      stripeSubscriptionId: 'sub_standard_update_without_consent',
      cancelAtPeriodEnd: false,
    });
    const subscription = makeStripeSubscription({
      id: 'sub_standard_update_without_consent',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });
    subscription.items.data[0]!.current_period_start = Math.floor(
      new Date(FINAL_COMMIT_END).getTime() / 1000
    );
    subscription.items.data[0]!.current_period_end = Math.floor(
      new Date('2026-12-01T00:00:00.000Z').getTime() / 1000
    );
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      id: subscription.id,
      schedule: null,
      cancel_at_period_end: true,
      items: subscription.items,
    });
    stripeMock.subscriptions.update.mockResolvedValue({});

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_standard_update_without_consent',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, existing.id));
    expect(row).toEqual(
      expect.objectContaining({
        plan: 'commit',
        current_period_start: '2026-05-01 00:00:00+00',
        current_period_end: '2026-11-01 00:00:00+00',
        cancel_at_period_end: false,
      })
    );
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(subscription.id, {
      cancel_at_period_end: true,
    });
  });

  it.each(['active', 'past_due', 'unpaid', 'canceled'] as const)(
    'preserves final Commit access and billing state for incoming Stripe %s update without consent',
    async stripeStatus => {
      const { subscription: existing } = await insertFinalCommitFixture({
        stripeSubscriptionId: `sub_manual_review_update_${stripeStatus}`,
        cancelAtPeriodEnd: true,
      });
      const subscription = makeStripeSubscription({
        id: `sub_manual_review_update_${stripeStatus}`,
        metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
        status: stripeStatus,
        cancel_at_period_end: false,
        priceId: 'price_standard',
      });
      subscription.items.data[0]!.current_period_start = Math.floor(
        new Date(FINAL_COMMIT_END).getTime() / 1000
      );
      subscription.items.data[0]!.current_period_end = Math.floor(
        new Date('2026-12-01T00:00:00.000Z').getTime() / 1000
      );
      stripeMock.subscriptions.retrieve.mockResolvedValue({
        id: subscription.id,
        schedule: null,
        cancel_at_period_end: true,
        items: subscription.items,
      });
      stripeMock.subscriptions.update.mockResolvedValue({});

      await handleKiloClawSubscriptionUpdated({
        eventId: `evt_manual_review_update_${stripeStatus}`,
        subscription,
      });

      const [row] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.id, existing.id));
      expect(row).toEqual(
        expect.objectContaining({
          status: 'active',
          plan: 'commit',
          current_period_start: '2026-05-01 00:00:00+00',
          current_period_end: '2026-11-01 00:00:00+00',
          commit_ends_at: '2026-11-01 00:00:00+00',
          cancel_at_period_end: true,
        })
      );
      expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(subscription.id, {
        cancel_at_period_end: true,
      });
    }
  );

  it('allows qualified pre-cutoff Commit recovery update without containing it', async () => {
    const instance = await createKiloclawInstance(user.id);
    const [existing] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        stripe_subscription_id: 'sub_qualified_recovery_update',
        payment_source: 'stripe',
        plan: 'commit',
        status: 'past_due',
        current_period_start: '2025-12-05T00:00:00.000Z',
        current_period_end: '2026-06-05T00:00:00.000Z',
      })
      .returning();
    if (!existing) throw new Error('Failed to insert recovery update fixture');
    const subscription = makeStripeSubscription({
      id: 'sub_qualified_recovery_update',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });
    subscription.items.data[0]!.current_period_start = Math.floor(
      new Date('2026-06-05T00:00:00.000Z').getTime() / 1000
    );
    subscription.items.data[0]!.current_period_end = Math.floor(
      new Date('2026-12-05T00:00:00.000Z').getTime() / 1000
    );

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_qualified_recovery_update',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, existing.id));
    expect(row).toEqual(
      expect.objectContaining({
        status: 'active',
        current_period_start: '2026-06-05 00:00:00+00',
        current_period_end: '2026-12-05 00:00:00+00',
        cancel_at_period_end: false,
      })
    );
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });

  it('maps Stripe active status to local active', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_active',
      plan: 'standard',
      status: 'active',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_active',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_active',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.status).toBe('active');
    expect(row.plan).toBe('standard');
  });

  it('does not extend commit_ends_at when a legacy Commit boundary has passed', async () => {
    const pastCommitEnd = new Date(Date.now() - 86_400_000).toISOString();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_renew',
      plan: 'commit',
      status: 'active',
      commit_ends_at: pastCommitEnd,
    });

    const subscription = makeStripeSubscription({
      id: 'sub_commit_renew',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce({
        ...subscription,
        schedule: null,
        cancel_at_period_end: false,
      })
      .mockResolvedValueOnce({
        ...subscription,
        schedule: null,
        cancel_at_period_end: true,
      });
    stripeMock.subscriptions.update.mockResolvedValue({});

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_commit_renew',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(new Date(row.commit_ends_at ?? '').toISOString()).toBe(pastCommitEnd);
  });

  it('does not extend commit_ends_at across multiple windows when far overdue', async () => {
    const farPastCommitEnd = new Date(Date.now() - 215 * 86_400_000).toISOString();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_commit_overdue',
      plan: 'commit',
      status: 'active',
      commit_ends_at: farPastCommitEnd,
    });

    const subscription = makeStripeSubscription({
      id: 'sub_commit_overdue',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce({
        ...subscription,
        schedule: null,
        cancel_at_period_end: false,
      })
      .mockResolvedValueOnce({
        ...subscription,
        schedule: null,
        cancel_at_period_end: true,
      });
    stripeMock.subscriptions.update.mockResolvedValue({});

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_commit_overdue',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(new Date(row.commit_ends_at ?? '').toISOString()).toBe(farPastCommitEnd);
  });

  it('ignores stale subscription.updated for a superseded subscription', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      stripe_subscription_id: 'sub_new',
      plan: 'standard',
      status: 'active',
    });

    // Stale webhook for an old subscription that was replaced
    const staleSubscription = makeStripeSubscription({
      id: 'sub_old',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'past_due',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionUpdated({
      eventId: 'evt_test_stale',
      subscription: staleSubscription,
    });

    // Local row should be unchanged — the stale webhook matched 0 rows
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_new');
    expect(row.plan).toBe('standard');
    expect(row.status).toBe('active');
  });
});

describe('handleKiloClawSubscriptionDeleted', () => {
  let handleKiloClawSubscriptionDeleted: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionDeleted = mod.handleKiloClawSubscriptionDeleted;
  });

  it('preserves ambiguous Commit state and access when provider deletes subscription', async () => {
    const instance = await createKiloclawInstance(user.id);
    const [existing] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        stripe_subscription_id: 'sub_deleted_manual_review',
        payment_source: 'credits',
        plan: 'commit',
        status: 'active',
        cancel_at_period_end: true,
        current_period_start: FINAL_COMMIT_START,
        current_period_end: FINAL_COMMIT_END,
        credit_renewal_at: FINAL_COMMIT_END,
      })
      .returning();
    if (!existing) throw new Error('Failed to insert ambiguous deleted fixture');
    const subscription = makeStripeSubscription({
      id: 'sub_deleted_manual_review',
      metadata: {
        type: 'kiloclaw',
        plan: 'commit',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'canceled',
      cancel_at_period_end: true,
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionDeleted({
      eventId: 'evt_deleted_manual_review',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, existing.id));
    expect(row).toEqual(
      expect.objectContaining({
        status: 'canceled',
        plan: 'commit',
        stripe_subscription_id: 'sub_deleted_manual_review',
        cancel_at_period_end: false,
      })
    );
  });

  it('converts a transferred Stripe predecessor on the current successor and preserves successor price version', async () => {
    const oldInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    const newInstance = await createKiloclawInstance(user.id);

    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: newInstance.id,
        payment_source: 'credits',
        plan: 'standard',
        status: 'active',
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
        credit_renewal_at: '2026-05-01T00:00:00.000Z',
        pending_conversion: true,
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: oldInstance.id,
      stripe_subscription_id: 'sub_lineage_deleted',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-03-01T00:00:00.000Z',
      current_period_end: '2026-04-01T00:00:00.000Z',
      pending_conversion: true,
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      transferred_to_subscription_id: successor?.id,
    });

    const subscription = makeStripeSubscription({
      id: 'sub_lineage_deleted',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: oldInstance.id,
      },
      status: 'canceled',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionDeleted({
      eventId: 'evt_lineage_deleted',
      subscription,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPredecessor = rows.find(row => row.instance_id === oldInstance.id);
    const updatedSuccessor = rows.find(row => row.instance_id === newInstance.id);

    expect(updatedPredecessor).toEqual(
      expect.objectContaining({
        stripe_subscription_id: null,
        payment_source: 'credits',
        status: 'active',
        pending_conversion: false,
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      })
    );
    expect(updatedSuccessor).toEqual(
      expect.objectContaining({
        stripe_subscription_id: null,
        payment_source: 'credits',
        status: 'active',
        pending_conversion: false,
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      })
    );
    expect(updatedSuccessor?.credit_renewal_at).toContain('2026-05-01');
  });
});

describe('handleKiloClawSubscriptionCreated', () => {
  let handleKiloClawSubscriptionCreated: (params: {
    eventId: string;
    subscription: Stripe.Subscription;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawSubscriptionCreated = mod.handleKiloClawSubscriptionCreated;
  });

  async function createWebhookAnchor(params?: {
    plan?: 'trial' | 'standard' | 'commit';
    status?: 'trialing' | 'active' | 'canceled';
    destroyedAt?: string;
    stripeSubscriptionId?: string;
  }) {
    const instance = await createKiloclawInstance(user.id, params?.destroyedAt);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: params?.plan ?? 'trial',
      status: params?.status ?? 'trialing',
      stripe_subscription_id: params?.stripeSubscriptionId,
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      current_period_start: params?.status === 'active' ? '2026-04-01T00:00:00.000Z' : null,
      current_period_end: params?.status === 'active' ? '2026-05-01T00:00:00.000Z' : null,
    });

    return instance;
  }

  it('upgrades a trial row to a paid subscription', async () => {
    const instance = await createWebhookAnchor();
    await db
      .update(kiloclaw_instances)
      .set({ inactive_trial_stopped_at: '2026-04-20T12:00:00.000Z' })
      .where(eq(kiloclaw_instances.id, instance.id));

    const subscription = makeStripeSubscription({
      id: 'sub_paid',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_trial_upgrade',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_paid');
    expect(row.plan).toBe('standard');
    expect(row.status).toBe('active');

    const [updatedInstance] = await db
      .select({ inactive: kiloclaw_instances.inactive_trial_stopped_at })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, instance.id))
      .limit(1);

    expect(updatedInstance?.inactive).toBeNull();
  });

  it('fails closed for pre-cutoff confirmed rowless Commit creation', async () => {
    const stripeSubscriptionId = 'sub_rowless_pre_cutoff_commit_created';
    const eventId = 'evt_rowless_pre_cutoff_commit_created';
    const subscription = makeStripeSubscription({
      id: stripeSubscriptionId,
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
      created: Math.floor(new Date('2026-06-05T23:59:59.000Z').getTime() / 1000),
    });
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      ...subscription,
      schedule: null,
      cancel_at_period_end: true,
    });
    stripeMock.subscriptions.update.mockResolvedValue({});

    await handleKiloClawSubscriptionCreated({ eventId, subscription });
    await handleKiloClawSubscriptionCreated({ eventId, subscription });

    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    await expect(
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    ).resolves.toHaveLength(0);
  });

  it('contains lineage-unresolved Commit creation without mutating lineage rows', async () => {
    const oldInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    const newInstance = await createKiloclawInstance(user.id);
    const [predecessor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: oldInstance.id,
        stripe_subscription_id: 'sub_created_lineage_cycle',
        payment_source: 'stripe',
        plan: 'commit',
        status: 'active',
        current_period_start: FINAL_COMMIT_START,
        current_period_end: FINAL_COMMIT_END,
      })
      .returning();
    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: newInstance.id,
        payment_source: 'credits',
        plan: 'commit',
        status: 'active',
        current_period_start: FINAL_COMMIT_START,
        current_period_end: FINAL_COMMIT_END,
        credit_renewal_at: FINAL_COMMIT_END,
        transferred_to_subscription_id: predecessor?.id,
      })
      .returning();
    await db
      .update(kiloclaw_subscriptions)
      .set({ transferred_to_subscription_id: successor?.id })
      .where(eq(kiloclaw_subscriptions.id, predecessor?.id ?? ''));
    const subscription = makeStripeSubscription({
      id: 'sub_created_lineage_cycle',
      metadata: {
        type: 'kiloclaw',
        plan: 'commit',
        kiloUserId: user.id,
        instanceId: oldInstance.id,
      },
      status: 'active',
      priceId: 'price_commit',
      created: Math.floor(new Date('2026-06-05T23:59:59.000Z').getTime() / 1000),
    });
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce({
        ...subscription,
        schedule: null,
        cancel_at_period_end: false,
      })
      .mockResolvedValueOnce({
        ...subscription,
        schedule: null,
        cancel_at_period_end: true,
      });
    stripeMock.subscriptions.update.mockResolvedValue({});

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_created_lineage_cycle',
      subscription,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    expect(rows.find(row => row.id === predecessor?.id)).toEqual(
      expect.objectContaining({
        stripe_subscription_id: 'sub_created_lineage_cycle',
        plan: 'commit',
        status: 'active',
        transferred_to_subscription_id: successor?.id,
      })
    );
    expect(rows.find(row => row.id === successor?.id)).toEqual(
      expect.objectContaining({
        stripe_subscription_id: null,
        plan: 'commit',
        status: 'active',
        transferred_to_subscription_id: predecessor?.id,
      })
    );
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(subscription.id, {
      cancel_at_period_end: true,
    });
  });

  it('attaches pre-deploy subscription.created without instanceId metadata to current personal row', async () => {
    await createWebhookAnchor();

    const subscription = makeStripeSubscription({
      id: 'sub_predeploy_created',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
      },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_predeploy_created',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_predeploy_created');
    expect(row.plan).toBe('standard');
    expect(row.status).toBe('active');
  });

  it('does not mutate a canceled legacy row when current checkout points at it', async () => {
    const instance = await createWebhookAnchor({
      plan: 'standard',
      status: 'canceled',
    });

    const subscription = makeStripeSubscription({
      id: 'sub_current_after_legacy_cancel',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_current_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_current_after_legacy_cancel',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row).toEqual(
      expect.objectContaining({
        stripe_subscription_id: null,
        plan: 'standard',
        status: 'canceled',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      })
    );
  });

  it('quarantines subscription.created when Stripe price version conflicts with a live lineage', async () => {
    const instance = await createWebhookAnchor();

    const subscription = makeStripeSubscription({
      id: 'sub_mismatched_price_version',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_current_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_mismatched_price_version',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row).toEqual(
      expect.objectContaining({
        stripe_subscription_id: null,
        plan: 'trial',
        status: 'trialing',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      })
    );
  });

  it('enqueues trial_end affiliate events when a Stripe subscription upgrades a delivered trial', async () => {
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);
    const instance = await createWebhookAnchor();

    const subscription = makeStripeSubscription({
      id: 'sub_affiliate_trial_upgrade',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_affiliate_trial_upgrade',
      subscription,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['signup', 'trial_end']);
    expect(events.find(event => event.event_type === 'trial_end')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
      })
    );
  });

  it('enqueues trial_end from persisted trial history when the paid row is already active', async () => {
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
    jest.setSystemTime(new Date('2026-04-10T12:00:00.000Z'));
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    const instance = await createKiloclawInstance(user.id);

    const trialStartedAt = '2026-04-01T00:00:00.000Z';
    const trialEndsAt = '2026-04-08T00:00:00.000Z';
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_affiliate_trial_upgrade_retry',
      plan: 'standard',
      status: 'active',
      trial_started_at: trialStartedAt,
      trial_ends_at: trialEndsAt,
      current_period_start: trialEndsAt,
      current_period_end: '2026-05-08T00:00:00.000Z',
    });

    const subscriptionCreatedAt = Math.floor(new Date('2026-04-09T10:15:00.000Z').getTime() / 1000);
    const subscription = makeStripeSubscription({
      id: 'sub_affiliate_trial_upgrade_retry',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_standard',
      created: subscriptionCreatedAt,
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_affiliate_trial_upgrade_retry',
      subscription,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['signup', 'trial_end']);
    expect(events.find(event => event.event_type === 'trial_end')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          eventDate: '2026-04-09T10:15:00.000Z',
          orderId: 'IR_AN_64_TS',
        }),
      })
    );

    jest.useRealTimers();
  });

  it('sets commit_ends_at for a new commit subscription', async () => {
    setTestSystemTime(PRE_COMMIT_CUTOFF_TIME);
    const instance = await createWebhookAnchor();
    const subscription = makeStripeSubscription({
      id: 'sub_commit_new',
      metadata: {
        type: 'kiloclaw',
        plan: 'commit',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_commit',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_commit_created',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_commit_new');
    expect(row.plan).toBe('commit');
    expect(row.status).toBe('active');
    // commit_ends_at should be set (6 months from period start)
    expect(row.commit_ends_at).not.toBeNull();
    // No schedule should be created — commit plans auto-renew
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('ignores stale subscription.created when user has a different active subscription', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_current',
      plan: 'standard',
      status: 'active',
    });

    const staleSubscription = makeStripeSubscription({
      id: 'sub_stale',
      metadata: {
        type: 'kiloclaw',
        plan: 'commit',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_commit',
    });
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce({
        ...staleSubscription,
        schedule: null,
        cancel_at_period_end: false,
      })
      .mockResolvedValueOnce({
        ...staleSubscription,
        schedule: null,
        cancel_at_period_end: true,
      });
    stripeMock.subscriptions.update.mockResolvedValue({});

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_stale_created',
      subscription: staleSubscription,
    });

    // Row should be unchanged
    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_current');
    expect(row.plan).toBe('standard');
  });

  it('calls ensureAutoIntroSchedule for intro-price subscription', async () => {
    const instance = await createWebhookAnchor();
    // Set up stripe.subscriptions.retrieve to return intro price
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.create.mockResolvedValue({
      id: 'sub_sched_auto',
      phases: [
        {
          items: [{ price: 'price_standard_intro' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const subscription = makeStripeSubscription({
      id: 'sub_intro',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_standard_intro',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_intro_created',
      subscription,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row.stripe_subscription_id).toBe('sub_intro');
    expect(row.plan).toBe('standard');
    // ensureAutoIntroSchedule should have been invoked
    expect(stripeMock.subscriptionSchedules.create).toHaveBeenCalled();
    expect(row.stripe_schedule_id).toBe('sub_sched_auto');
    expect(row.scheduled_plan).toBe('standard');
    expect(row.scheduled_by).toBe('auto');
  });

  it('repairs half-configured auto-intro schedule on retry', async () => {
    const instance = await createWebhookAnchor();
    // Simulate: first attempt created the schedule (from_subscription) and tagged
    // it auto-intro, but the 2-phase rewrite never completed. On retry, the
    // subscription has a schedule attached with auto-intro metadata but only 1 phase.
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_half',
      items: { data: [{ price: { id: 'price_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_half',
      metadata: { origin: 'auto-intro' },
      // Only 1 phase — the 2-phase rewrite never completed
      phases: [
        {
          items: [{ price: 'price_standard_intro' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const subscription = makeStripeSubscription({
      id: 'sub_half_repair',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_standard_intro',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_half_repair',
      subscription,
    });

    // Should have rewritten the schedule with 2 phases
    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sched_half',
      expect.objectContaining({
        end_behavior: 'release',
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: [{ price: 'price_standard_intro' }],
          }),
          expect.objectContaining({
            items: [{ price: 'price_test_kiloclaw' }],
          }),
        ]),
      })
    );

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);
    expect(row.stripe_schedule_id).toBe('sched_half');
    expect(row.scheduled_by).toBe('auto');
  });

  it('repairs legacy intro schedules to the same version recurring standard price', async () => {
    stripePriceIdsMock.isIntroPriceId.mockImplementation(
      (priceId: string) => priceId === 'price_legacy_standard_intro'
    );
    stripePriceIdsMock.getStripePriceIdMetadata.mockImplementation((priceId: string) =>
      priceId === 'price_legacy_standard_intro'
        ? {
            plan: 'standard',
            priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
            isIntro: true,
          }
        : null
    );
    stripePriceIdsMock.getStripePriceIdForClawPlan.mockImplementation(
      (plan: string, options?: { priceVersion?: string }) =>
        `${options?.priceVersion ?? 'missing-version'}_${plan}`
    );

    const instance = await createWebhookAnchor();
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: 'sched_legacy_half',
      items: { data: [{ price: { id: 'price_legacy_standard_intro' } }] },
    });
    stripeMock.subscriptionSchedules.retrieve.mockResolvedValue({
      id: 'sched_legacy_half',
      metadata: { origin: 'auto-intro' },
      phases: [
        {
          items: [{ price: 'price_legacy_standard_intro' }],
          start_date: 1000,
          end_date: 2000,
        },
      ],
      status: 'active',
    });
    stripeMock.subscriptionSchedules.update.mockResolvedValue({});

    const subscription = makeStripeSubscription({
      id: 'sub_legacy_half_repair',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_legacy_standard_intro',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_legacy_half_repair',
      subscription,
    });

    expect(stripeMock.subscriptionSchedules.update).toHaveBeenCalledWith(
      'sched_legacy_half',
      expect.objectContaining({
        phases: expect.arrayContaining([
          expect.objectContaining({
            items: [{ price: 'price_legacy_standard_intro' }],
          }),
          expect.objectContaining({
            items: [{ price: `${LEGACY_KILOCLAW_PRICE_VERSION}_standard` }],
          }),
        ]),
      })
    );
  });

  it('does not create auto schedule for regular-price subscription (returning subscriber)', async () => {
    const instance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_old_canceled',
    });

    // Regular price — isIntroPriceId returns false
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const subscription = makeStripeSubscription({
      id: 'sub_regular_return',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_regular_created',
      subscription,
    });

    // Should NOT create a schedule
    expect(stripeMock.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  it('quarantines personal subscription.created when no personal billing anchor exists', async () => {
    const organization = await createOrganization('Org Webhook Test', user.id);
    await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        organization_id: organization.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();

    const subscription = makeStripeSubscription({
      id: 'sub_personal_checkout',
      metadata: { type: 'kiloclaw', plan: 'standard', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_standard',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_org_scope_test',
      subscription,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.stripe_subscription_id, 'sub_personal_checkout'));

    expect(rows).toHaveLength(0);
  });

  it('reattaches a predecessor Stripe row to current successor row', async () => {
    const oldInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    const newInstance = await createKiloclawInstance(user.id);

    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: newInstance.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-04-10T00:00:00.000Z',
        trial_ends_at: '2026-04-17T00:00:00.000Z',
      })
      .returning();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: oldInstance.id,
      stripe_subscription_id: 'sub_lineage_created',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'canceled',
      current_period_start: '2026-03-01T00:00:00.000Z',
      current_period_end: '2026-04-01T00:00:00.000Z',
      transferred_to_subscription_id: successor?.id,
    });

    const subscription = makeStripeSubscription({
      id: 'sub_lineage_created',
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: oldInstance.id,
      },
      status: 'active',
      priceId: 'price_standard',
    });

    await handleKiloClawSubscriptionCreated({
      eventId: 'evt_lineage_created',
      subscription,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPredecessor = rows.find(row => row.instance_id === oldInstance.id);
    const updatedSuccessor = rows.find(row => row.instance_id === newInstance.id);

    expect(updatedPredecessor?.stripe_subscription_id).toBeNull();
    expect(updatedPredecessor?.payment_source).toBe('credits');
    expect(updatedSuccessor).toMatchObject({
      stripe_subscription_id: 'sub_lineage_created',
      plan: 'standard',
      status: 'active',
    });
  });
});

describe('handleKiloClawScheduleEvent', () => {
  it('preserves durable pending-final qualification after terminal schedule clears tracking', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_pending_final_schedule',
      stripe_schedule_id: 'sched_pending_final',
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
      current_period_start: '2026-05-01T00:00:00.000Z',
      current_period_end: '2026-06-10T00:00:00.000Z',
    });
    const { handleKiloClawScheduleEvent } = await import('@/lib/kiloclaw/stripe-handlers');

    await handleKiloClawScheduleEvent({
      eventId: 'evt_pending_final_schedule_terminal',
      schedule: {
        id: 'sched_pending_final',
        status: 'completed',
        subscription: 'sub_pending_final_schedule',
      } as Stripe.SubscriptionSchedule,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
    expect(row).toEqual(
      expect.objectContaining({
        plan: 'standard',
        scheduled_plan: null,
        stripe_schedule_id: null,
      })
    );
  });
});

describe('handleKiloClawInvoicePaid affiliate events', () => {
  let handleKiloClawInvoicePaid: (params: {
    eventId: string;
    invoice: Stripe.Invoice;
  }) => Promise<void>;

  beforeAll(async () => {
    const mod = await import('@/lib/kiloclaw/stripe-handlers');
    handleKiloClawInvoicePaid = mod.handleKiloClawInvoicePaid;
  });

  it('enqueues sale affiliate events for delivered attributed users', async () => {
    const paidAt = new Date('2026-04-09T10:00:00.000Z');
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email, paidAt);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_invoice_paid',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
      },
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawInvoicePaid({
      eventId: 'evt_invoice_paid_affiliate',
      invoice: {
        id: 'in_affiliate_sale',
        amount_paid: 900,
        currency: 'usd',
        charge: 'ch_affiliate_sale',
        parent: {
          subscription_details: {
            subscription: 'sub_invoice_paid',
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
        status_transitions: {
          paid_at: Math.floor(paidAt.getTime() / 1000),
        },
      } as unknown as Stripe.Invoice,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup']);
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        payload_json: expect.objectContaining({
          amount: 9,
          currencyCode: 'usd',
          itemCategory: 'kiloclaw-standard-2026-03-19',
          itemName: 'KiloClaw Standard Plan',
          orderId: 'in_affiliate_sale',
        }),
      })
    );
  });

  it('enqueues sale affiliate events for positive attributed invoices without a charge id', async () => {
    const paidAt = new Date('2026-04-09T10:00:00.000Z');
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email, paidAt);

    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({ user_id: user.id, sandbox_id: sandboxIdFromUserId(user.id) })
      .returning();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_invoice_paid_without_charge',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
      },
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawInvoicePaid({
      eventId: 'evt_invoice_paid_affiliate_without_charge',
      invoice: {
        id: 'in_affiliate_sale_without_charge',
        amount_paid: 900,
        currency: 'usd',
        charge: null,
        parent: {
          subscription_details: {
            subscription: 'sub_invoice_paid_without_charge',
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
        status_transitions: {
          paid_at: Math.floor(paidAt.getTime() / 1000),
        },
      } as unknown as Stripe.Invoice,
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));

    expect(events.map(event => event.event_type).sort()).toEqual(['sale', 'signup']);
    expect(events.find(event => event.event_type === 'sale')).toEqual(
      expect.objectContaining({
        delivery_state: 'queued',
        stripe_charge_id: null,
        payload_json: expect.objectContaining({
          amount: 9,
          currencyCode: 'usd',
          orderId: 'in_affiliate_sale_without_charge',
          stripeChargeId: null,
        }),
      })
    );
  });

  it('fails closed for an unresolved paid Commit invoice without local persistence', async () => {
    const stripeSubscriptionId = 'sub_rowless_paid_commit';
    const eventId = 'evt_rowless_paid_commit';
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce({
        id: stripeSubscriptionId,
        created: Math.floor(new Date('2026-06-07T00:00:00.000Z').getTime() / 1000),
        metadata: {
          type: 'kiloclaw',
          plan: 'commit',
          kiloUserId: user.id,
        },
        schedule: 'sched_rowless_paid_commit',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_current_commit' } }] },
      })
      .mockResolvedValueOnce({
        id: stripeSubscriptionId,
        schedule: 'sched_rowless_paid_commit',
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_current_commit' } }] },
      })
      .mockResolvedValueOnce({
        id: stripeSubscriptionId,
        schedule: null,
        cancel_at_period_end: true,
        items: { data: [{ price: { id: 'price_current_commit' } }] },
      });
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.update.mockResolvedValue({});

    const invoice = {
      id: 'in_rowless_paid_commit',
      amount_paid: 30_600,
      currency: 'usd',
      charge: 'ch_rowless_paid_commit',
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
                price: 'price_current_commit',
              },
            },
            period: {
              start: Math.floor(new Date('2026-06-07T00:00:00.000Z').getTime() / 1000),
              end: Math.floor(new Date('2026-12-07T00:00:00.000Z').getTime() / 1000),
            },
          },
        ],
      },
    } as unknown as Stripe.Invoice;

    await handleKiloClawInvoicePaid({ eventId, invoice });
    await handleKiloClawInvoicePaid({ eventId, invoice });

    await expect(
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    ).resolves.toHaveLength(0);
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sched_rowless_paid_commit'
    );
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith(stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    expect(posthogCaptureMock).not.toHaveBeenCalled();
  });

  it('leaves no local subscription when unresolved paid Commit provider non-renewal fails', async () => {
    const stripeSubscriptionId = 'sub_rowless_paid_commit_provider_failure';
    const eventId = 'evt_rowless_paid_commit_provider_failure';
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce({
        id: stripeSubscriptionId,
        created: Math.floor(new Date('2026-06-07T00:00:00.000Z').getTime() / 1000),
        metadata: {
          type: 'kiloclaw',
          plan: 'commit',
          kiloUserId: user.id,
        },
        schedule: null,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_current_commit' } }] },
      })
      .mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(
      handleKiloClawInvoicePaid({
        eventId,
        invoice: {
          id: 'in_rowless_paid_commit_provider_failure',
          amount_paid: 30_600,
          currency: 'usd',
          charge: 'ch_rowless_paid_commit_provider_failure',
          parent: {
            subscription_details: { subscription: stripeSubscriptionId },
          },
          lines: {
            data: [
              {
                pricing: { price_details: { price: 'price_current_commit' } },
                period: {
                  start: Math.floor(new Date('2026-06-07T00:00:00.000Z').getTime() / 1000),
                  end: Math.floor(new Date('2026-12-07T00:00:00.000Z').getTime() / 1000),
                },
              },
            ],
          },
        } as unknown as Stripe.Invoice,
      })
    ).rejects.toThrow('provider unavailable');

    await expect(
      db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.stripe_subscription_id, stripeSubscriptionId))
    ).resolves.toHaveLength(0);
  });

  it('settles pre-deploy invoice.paid without instanceId metadata onto current personal row', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: '2026-04-10T00:00:00.000Z',
      trial_ends_at: '2026-04-17T00:00:00.000Z',
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
      },
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawInvoicePaid({
      eventId: 'evt_predeploy_invoice_paid',
      invoice: {
        id: 'in_predeploy_paid',
        amount_paid: 900,
        currency: 'usd',
        charge: 'ch_predeploy_paid',
        parent: {
          subscription_details: {
            subscription: 'sub_predeploy_invoice',
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
        status_transitions: {
          paid_at: Math.floor(new Date('2026-04-09T10:00:00.000Z').getTime() / 1000),
        },
      } as unknown as Stripe.Invoice,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(row).toMatchObject({
      stripe_subscription_id: 'sub_predeploy_invoice',
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      instance_id: instance.id,
    });
  });

  it('settles invoice.paid onto current successor row and clears predecessor Stripe ownership', async () => {
    const oldInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    const newInstance = await createKiloclawInstance(user.id);

    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: newInstance.id,
        plan: 'trial',
        status: 'trialing',
        trial_started_at: '2026-04-10T00:00:00.000Z',
        trial_ends_at: '2026-04-17T00:00:00.000Z',
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      })
      .returning();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: oldInstance.id,
      stripe_subscription_id: 'sub_lineage_invoice',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'canceled',
      current_period_start: '2026-03-01T00:00:00.000Z',
      current_period_end: '2026-04-01T00:00:00.000Z',
      kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      transferred_to_subscription_id: successor?.id,
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: oldInstance.id,
      },
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawInvoicePaid({
      eventId: 'evt_lineage_invoice_paid',
      invoice: {
        id: 'in_lineage_paid',
        amount_paid: 900,
        currency: 'usd',
        charge: 'ch_lineage_paid',
        parent: {
          subscription_details: {
            subscription: 'sub_lineage_invoice',
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
                start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
        status_transitions: {
          paid_at: Math.floor(new Date('2026-04-09T10:00:00.000Z').getTime() / 1000),
        },
      } as unknown as Stripe.Invoice,
    });

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const updatedPredecessor = rows.find(row => row.instance_id === oldInstance.id);
    const updatedSuccessor = rows.find(row => row.instance_id === newInstance.id);

    expect(updatedPredecessor?.stripe_subscription_id).toBeNull();
    expect(updatedPredecessor?.payment_source).toBe('credits');
    expect(updatedPredecessor?.kiloclaw_price_version).toBe(LEGACY_KILOCLAW_PRICE_VERSION);
    expect(updatedSuccessor).toMatchObject({
      stripe_subscription_id: 'sub_lineage_invoice',
      payment_source: 'credits',
      status: 'active',
      instance_id: newInstance.id,
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
    });
    const [settlement] = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.description, 'KiloClaw standard settlement')
        )
      );
    expect(settlement).toMatchObject({
      paid_credit_policy: 'settlement',
      credit_source: 'settlement',
      expiry_date: null,
      amount_microdollars: 9_000_000,
    });
    const [deduction] = await db
      .select()
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.kilo_user_id, user.id),
          eq(credit_transactions.description, 'KiloClaw standard period deduction')
        )
      );
    expect(deduction).toMatchObject({
      paid_credit_policy: 'settlement',
      credit_source: 'settlement',
      expiry_date: null,
      amount_microdollars: -9_000_000,
    });
  });

  it('settles zero-dollar invoice.paid without emitting revenue events', async () => {
    await seedDeliveredImpactSignupEvent(user.id, user.google_user_email);

    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_zero_amount_invoice',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
      cancel_at_period_end: false,
    });

    stripeMock.subscriptions.retrieve.mockResolvedValue({
      metadata: {
        type: 'kiloclaw',
        plan: 'standard',
        kiloUserId: user.id,
        instanceId: instance.id,
      },
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    await handleKiloClawInvoicePaid({
      eventId: 'evt_zero_amount_invoice_paid',
      invoice: {
        id: 'in_zero_amount_paid',
        amount_paid: 0,
        currency: 'usd',
        charge: null,
        parent: {
          subscription_details: {
            subscription: 'sub_zero_amount_invoice',
          },
        },
        lines: {
          data: [
            {
              pricing: {
                price_details: {
                  price: 'price_standard',
                },
              },
              period: {
                start: Math.floor(new Date('2026-04-01T00:00:00.000Z').getTime() / 1000),
                end: Math.floor(new Date('2026-05-01T00:00:00.000Z').getTime() / 1000),
              },
            },
          ],
        },
        status_transitions: {
          paid_at: Math.floor(new Date('2026-04-09T10:00:00.000Z').getTime() / 1000),
        },
      } as unknown as Stripe.Invoice,
    });

    const [updatedRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instance.id))
      .limit(1);

    expect(updatedRow).toMatchObject({
      stripe_subscription_id: 'sub_zero_amount_invoice',
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
    });
    expect(updatedRow?.credit_renewal_at).toContain('2026-05-01');

    const [creditTx] = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.stripe_payment_id, 'in_zero_amount_paid'))
      .limit(1);
    expect(creditTx).toMatchObject({
      stripe_payment_id: 'in_zero_amount_paid',
      amount_microdollars: 0,
      description: 'KiloClaw standard settlement',
    });

    const events = await db
      .select()
      .from(user_affiliate_events)
      .where(eq(user_affiliate_events.user_id, user.id));
    expect(events.map(event => event.event_type)).toEqual(['signup']);
    expect(posthogCaptureMock).not.toHaveBeenCalled();
  });
});

// ── Stripe-Funded Credit Settlement ─────────────────────────────────────────

describe('applyStripeFundedKiloClawPeriod', () => {
  async function giveUserCredits(userId: string, microdollars: number) {
    await db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: microdollars })
      .where(eq(kilocode_users.id, userId));
  }

  it('clears destruction fields and records resume retry state when settlement activates a suspended trial', async () => {
    await giveUserCredits(user.id, 1_000_000);
    const instance = await createKiloclawInstance(user.id);
    const now = new Date();
    const suspendedAt = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    const deadline = new Date(now.getTime() - 3 * 86_400_000).toISOString();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_settlement_resume',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'trial',
      status: 'canceled',
      trial_started_at: new Date(now.getTime() - 17 * 86_400_000).toISOString(),
      trial_ends_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      suspended_at: suspendedAt,
      destruction_deadline: deadline,
      auto_resume_requested_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      auto_resume_retry_after: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
      auto_resume_attempt_count: 3,
    });

    const { applyStripeFundedKiloClawPeriod } = await import('@/lib/kiloclaw/credit-billing');
    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId: 'sub_settlement_resume',
      stripePaymentId: 'ch_settlement_resume',
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 9_000_000,
      periodStart: '2026-04-16T09:40:37.000Z',
      periodEnd: '2026-05-16T09:40:37.000Z',
    });

    expect(applied).toBe(true);

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(subscription).toEqual(
      expect.objectContaining({
        status: 'active',
        payment_source: 'credits',
        stripe_subscription_id: 'sub_settlement_resume',
        plan: 'standard',
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_attempt_count: 1,
      })
    );
    expect(subscription.auto_resume_requested_at).toEqual(expect.any(String));
    expect(subscription.auto_resume_retry_after).toEqual(expect.any(String));
    expect(kiloclawInternalClientMock.__startAsyncMock).toHaveBeenCalledTimes(1);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, subscription.id));
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        status: 'active',
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_requested_at: null,
        auto_resume_retry_after: null,
        auto_resume_attempt_count: 0,
      })
    );
  });

  it('quarantines cyclic transferred lineage without mutating either subscription', async () => {
    const oldInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    const newInstance = await createKiloclawInstance(user.id);

    const [predecessor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: oldInstance.id,
        stripe_subscription_id: 'sub_settlement_cycle',
        payment_source: 'stripe',
        plan: 'standard',
        status: 'active',
        current_period_start: '2026-03-01T00:00:00.000Z',
        current_period_end: '2026-04-01T00:00:00.000Z',
        kiloclaw_price_version: LEGACY_KILOCLAW_PRICE_VERSION,
      })
      .returning();
    const [successor] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: newInstance.id,
        payment_source: 'credits',
        plan: 'standard',
        status: 'active',
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
        credit_renewal_at: '2026-05-01T00:00:00.000Z',
        transferred_to_subscription_id: predecessor?.id,
        kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      })
      .returning();
    await db
      .update(kiloclaw_subscriptions)
      .set({ transferred_to_subscription_id: successor?.id })
      .where(eq(kiloclaw_subscriptions.id, predecessor?.id ?? ''));

    const { applyStripeFundedKiloClawPeriod } = await import('@/lib/kiloclaw/credit-billing');
    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: oldInstance.id,
      stripeSubscriptionId: 'sub_settlement_cycle',
      stripePaymentId: 'ch_settlement_cycle',
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 9_000_000,
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-05-01T00:00:00.000Z',
    });

    expect(applied).toBe(false);

    const rows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));
    const predecessorAfter = rows.find(row => row.id === predecessor?.id);
    const successorAfter = rows.find(row => row.id === successor?.id);

    expect(predecessorAfter).toEqual(
      expect.objectContaining({
        stripe_subscription_id: 'sub_settlement_cycle',
        payment_source: 'stripe',
        status: 'active',
        transferred_to_subscription_id: successor?.id,
      })
    );
    expect(successorAfter).toEqual(
      expect.objectContaining({
        stripe_subscription_id: null,
        payment_source: 'credits',
        status: 'active',
        transferred_to_subscription_id: predecessor?.id,
      })
    );

    const transactions = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id));
    expect(transactions).toHaveLength(0);
  });

  it('keeps settlement subscription retryable when auto-resume request fails', async () => {
    kiloclawInternalClientMock.__startAsyncMock.mockRejectedValueOnce(new Error('start failed'));
    await giveUserCredits(user.id, 1_000_000);
    const instance = await createKiloclawInstance(user.id);
    const now = new Date();

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_settlement_resume_failed',
      payment_source: 'stripe',
      kiloclaw_price_version: CURRENT_KILOCLAW_PRICE_VERSION,
      plan: 'trial',
      status: 'canceled',
      trial_started_at: new Date(now.getTime() - 17 * 86_400_000).toISOString(),
      trial_ends_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      suspended_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
      destruction_deadline: new Date(now.getTime() - 3 * 86_400_000).toISOString(),
      auto_resume_requested_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      auto_resume_retry_after: new Date(now.getTime() - 1 * 86_400_000).toISOString(),
      auto_resume_attempt_count: 3,
    });

    const { applyStripeFundedKiloClawPeriod } = await import('@/lib/kiloclaw/credit-billing');
    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId: 'sub_settlement_resume_failed',
      stripePaymentId: 'ch_settlement_resume_failed',
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      amountMicrodollars: 9_000_000,
      periodStart: '2026-04-16T09:40:37.000Z',
      periodEnd: '2026-05-16T09:40:37.000Z',
    });

    expect(applied).toBe(true);

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id))
      .limit(1);

    expect(subscription).toEqual(
      expect.objectContaining({
        status: 'active',
        payment_source: 'credits',
        suspended_at: null,
        destruction_deadline: null,
        auto_resume_attempt_count: 1,
      })
    );
    expect(subscription.auto_resume_requested_at).toEqual(expect.any(String));
    expect(subscription.auto_resume_retry_after).toEqual(expect.any(String));
  });
});
