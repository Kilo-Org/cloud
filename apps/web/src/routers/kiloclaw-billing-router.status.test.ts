import {
  FINAL_COMMIT_END,
  FINAL_COMMIT_START,
  MockKiloClawApiError,
  createCallerForUser,
  createCanceledTrialAndPaidSubscriptions,
  createKiloclawInstance,
  insertFinalCommitFixture,
  kiloclawInternalClientMock,
  makeStripeSubscription,
  setTestSystemTime,
  stripeMock,
  user,
} from './kiloclaw-billing-router.test-harness';
import { describe, expect, it, jest } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  kiloclaw_earlybird_purchases,
  kiloclaw_subscriptions,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  credit_transactions,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getBillingStatus', () => {
  it('returns trialEligible true when user has no instance rows and no subscription', async () => {
    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(true);
    expect(result.hasExistingPersonalSubscription).toBe(false);
  });

  it('returns trialEligible false when user only has a destroyed personal instance row', async () => {
    await db.insert(kiloclaw_instances).values({
      user_id: user.id,
      sandbox_id: 'sandbox-destroyed',
      destroyed_at: new Date().toISOString(),
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(false);
    expect(result.hasExistingPersonalSubscription).toBe(false);
  });

  it('returns trialEligible false when user has an active personal instance row', async () => {
    await db.insert(kiloclaw_instances).values({
      user_id: user.id,
      sandbox_id: 'sandbox-active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(false);
    expect(result.hasExistingPersonalSubscription).toBe(false);
  });

  it('returns trialEligible false when user has a canceled subscription but no instance', async () => {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_canceled_old',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result).not.toBeNull();
    expect(result.trialEligible).toBe(false);
    expect(result.hasExistingPersonalSubscription).toBe(true);
    expect(result.hasCurrentPersonalSubscription).toBe(false);
  });

  it('returns trialEligible false when user only has an org-backed subscription', async () => {
    const organization = await createOrganization('Org Trial Test', user.id);
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
      stripe_subscription_id: 'sub_org_trial_test',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    // Must be false — ensureProvisionAccess checks ALL subscriptions (including
    // org) and would block trial creation, so trialEligible must agree.
    expect(result.trialEligible).toBe(false);
    expect(result.hasExistingPersonalSubscription).toBe(false);
  });

  it('prefers an active subscription over an older canceled row', async () => {
    const destroyedInstance = await createKiloclawInstance(user.id, '2026-04-01T00:00:00.000Z');
    const activeInstance = await createKiloclawInstance(user.id);
    const [activeRow] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: activeInstance.id,
        plan: 'standard',
        status: 'active',
        stripe_subscription_id: 'sub_status_active_latest',
        current_period_end: '2026-05-01T00:00:00.000Z',
      })
      .returning();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: destroyedInstance.id,
      plan: 'standard',
      status: 'canceled',
      stripe_subscription_id: 'sub_status_canceled_old',
      current_period_end: '2026-03-01T00:00:00.000Z',
      transferred_to_subscription_id: activeRow?.id,
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.currentPeriodEnd).toBe('2026-05-01T00:00:00.000Z');
  });

  it('prefers an active paid subscription over a canceled trial on a destroyed instance', async () => {
    const { trialInstance } = await createCanceledTrialAndPaidSubscriptions({
      paidStripeSubscriptionId: 'sub_status_effective_paid',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasAccess).toBe(true);
    expect(result.accessReason).toBe('subscription');
    expect(result.subscription?.status).toBe('active');
    expect(result.subscription?.currentPeriodEnd).toBe('2026-05-01T00:00:00.000Z');
    expect(result.instance?.exists).toBe(true);
    expect(result.instance?.destroyed).toBe(false);

    const adoptedTrialRows = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, trialInstance.id));
    expect(adoptedTrialRows).toHaveLength(1);
  });

  it('reports Stripe-created paid rows as pending settlement without granting access', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_status_pending_settlement',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasAccess).toBe(false);
    expect(result.accessReason).toBeNull();
    expect(result.subscription).toMatchObject({
      plan: 'standard',
      status: 'active',
      activationState: 'pending_settlement',
      paymentSource: 'stripe',
      hasStripeFunding: true,
    });
    expect(result.instance).toMatchObject({
      id: instance.id,
      exists: true,
      destroyed: false,
    });
  });

  it('preserves unpaid Stripe-backed rows as failed instead of pending settlement', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_status_unpaid',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'unpaid',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingStatus();

    expect(result.hasAccess).toBe(false);
    expect(result.accessReason).toBeNull();
    expect(result.subscription).toMatchObject({
      plan: 'standard',
      status: 'unpaid',
      activationState: 'activated',
      paymentSource: 'stripe',
      hasStripeFunding: true,
    });
  });
});

describe('provision detached personal billing recovery', () => {
  it('allows reprovisioning when only detached access-granting row remains', async () => {
    const provisionResult = {
      sandboxId: `test-sandbox-${crypto.randomUUID()}`,
      instanceId: crypto.randomUUID(),
    };
    kiloclawInternalClientMock.__provisionMock.mockResolvedValue(provisionResult);

    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      stripe_subscription_id: 'sub_detached_reprovision',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.provision({})).resolves.toEqual(provisionResult);

    expect(kiloclawInternalClientMock.__provisionMock).toHaveBeenCalledWith(
      user.id,
      expect.any(Object),
      undefined
    );
  });

  it('bootstraps detached access-granting row onto active instance when active row missing', async () => {
    const activeInstance = await createKiloclawInstance(user.id);
    kiloclawInternalClientMock.__provisionMock.mockResolvedValue({
      sandboxId: activeInstance.sandbox_id,
      instanceId: activeInstance.id,
    });
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      stripe_subscription_id: 'sub_detached_active_instance',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_start: '2026-04-01T00:00:00.000Z',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.provision({})).resolves.toEqual({
      sandboxId: activeInstance.sandbox_id,
      instanceId: activeInstance.id,
    });

    expect(kiloclawInternalClientMock.__provisionMock).toHaveBeenCalledWith(
      user.id,
      expect.any(Object),
      {
        instanceId: activeInstance.id,
        bootstrapSubscription: true,
      }
    );
  });

  it.each(['provision', 'updateConfig'] as const)(
    'rejects new personal subscriptions from kiloclaw.%s',
    async procedure => {
      const caller = await createCallerForUser(user.id);

      await expect(caller.kiloclaw[procedure]({})).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'A current KiloClaw subscription is required to provision an instance.',
      });
      expect(kiloclawInternalClientMock.__provisionMock).not.toHaveBeenCalled();
    }
  );

  it('does not bootstrap a fresh trial onto an active orphan instance', async () => {
    await createKiloclawInstance(user.id);

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.provision({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'A current KiloClaw subscription is required to provision an instance.',
    });

    expect(kiloclawInternalClientMock.__provisionMock).not.toHaveBeenCalled();
  });

  it('rejects reprovision for legacy earlybird purchase without canonical subscription row', async () => {
    await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_earlybird_purchases).values({
      user_id: user.id,
      amount_cents: 2500,
    });

    const caller = await createCallerForUser(user.id);
    await expect(caller.kiloclaw.provision({})).rejects.toThrow(
      'Legacy earlybird access requires manual remediation before reprovisioning.'
    );

    expect(kiloclawInternalClientMock.__provisionMock).not.toHaveBeenCalled();
  });

  it.each(['provision', 'updateConfig'] as const)(
    'maps Worker admission conflicts from kiloclaw.%s',
    async procedure => {
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        instance_id: null,
        stripe_subscription_id: `sub_admission_conflict_${procedure}`,
        payment_source: 'stripe',
        plan: 'standard',
        status: 'active',
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
      });
      kiloclawInternalClientMock.__provisionMock.mockRejectedValueOnce(
        new MockKiloClawApiError(
          409,
          JSON.stringify({
            error:
              'An instance is already being created. Wait for setup to finish, then try again.',
            code: 'provision_in_progress',
          })
        )
      );

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw[procedure]({})).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'An instance is already being created. Wait for setup to finish, then try again.',
      });
    }
  );

  it.each(['provision', 'updateConfig'] as const)(
    'maps missing Worker instances from kiloclaw.%s',
    async procedure => {
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        instance_id: null,
        stripe_subscription_id: `sub_missing_instance_${procedure}`,
        payment_source: 'stripe',
        plan: 'standard',
        status: 'active',
        current_period_start: '2026-04-01T00:00:00.000Z',
        current_period_end: '2026-05-01T00:00:00.000Z',
      });
      kiloclawInternalClientMock.__provisionMock.mockRejectedValueOnce(
        new MockKiloClawApiError(
          404,
          JSON.stringify({
            error: 'Active instance not found',
            code: 'instance_not_found',
          })
        )
      );

      const caller = await createCallerForUser(user.id);
      await expect(caller.kiloclaw[procedure]({})).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'Active instance not found',
      });
    }
  );
});

describe('requireKiloClawAccess', () => {
  it('logs structured subscription diagnostics before rejecting', async () => {
    const { requireKiloClawAccess } = await import('@/lib/kiloclaw/access-gate');

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const instance = await createKiloclawInstance(user.id);
      await db.insert(kiloclaw_subscriptions).values({
        user_id: user.id,
        instance_id: instance.id,
        plan: 'standard',
        status: 'canceled',
        current_period_end: '2026-04-01T00:00:00.000Z',
        suspended_at: '2026-04-02T00:00:00.000Z',
      });

      await expect(requireKiloClawAccess(user.id)).rejects.toThrow(
        'KiloClaw access requires an active subscription or trial.'
      );

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [warnArg] = warnSpy.mock.calls[0] ?? [];
      expect(typeof warnArg).toBe('string');
      const parsed = JSON.parse(warnArg as string) as {
        event: string;
        userId: string;
        subscriptionCount: number;
        effectiveSubscription:
          | {
              id: string;
              status: string;
              plan: string;
              suspended_at: string | null;
              instance_id: string | null;
            }
          | 'none';
        accessReason: string | null;
      };

      expect(parsed).toMatchObject({
        event: 'kiloclaw_access_denied',
        userId: user.id,
        accessReason: null,
      });
      expect(parsed.effectiveSubscription).not.toBe('none');
      expect(parsed.effectiveSubscription).toMatchObject({
        status: 'canceled',
        plan: 'standard',
        suspended_at: expect.stringContaining('2026-04-02'),
        instance_id: instance.id,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects pending-settlement rows until settlement activates access', async () => {
    const { requireKiloClawAccess } = await import('@/lib/kiloclaw/access-gate');

    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      stripe_subscription_id: 'sub_pending_access_gate',
      payment_source: 'stripe',
      plan: 'standard',
      status: 'active',
      current_period_end: '2026-05-01T00:00:00.000Z',
    });

    await expect(requireKiloClawAccess(user.id)).rejects.toThrow(
      'KiloClaw access requires an active subscription or trial.'
    );
  });
});

describe('subscription center procedures', () => {
  async function createInstanceRow(params: {
    userId: string;
    organizationId?: string;
    name?: string;
    destroyedAt?: string;
    sandboxId?: string;
  }) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: params.userId,
        organization_id: params.organizationId,
        name: params.name,
        destroyed_at: params.destroyedAt,
        sandbox_id: params.sandboxId ?? `sandbox-${crypto.randomUUID()}`,
      })
      .returning();

    if (!instance) {
      throw new Error('Failed to insert KiloClaw instance');
    }

    return instance;
  }

  async function insertSubscriptionRow(params: {
    userId: string;
    instanceId: string;
    stripeSubscriptionId?: string;
    paymentSource?: 'credits' | 'stripe';
    plan: 'standard' | 'commit' | 'trial';
    status: 'active' | 'past_due' | 'canceled' | 'unpaid' | 'trialing';
    createdAt?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
    creditRenewalAt?: string;
    cancelAtPeriodEnd?: boolean;
    transferredToSubscriptionId?: string;
  }) {
    await db.insert(kiloclaw_subscriptions).values({
      user_id: params.userId,
      instance_id: params.instanceId,
      stripe_subscription_id: params.stripeSubscriptionId,
      payment_source: params.paymentSource,
      plan: params.plan,
      status: params.status,
      created_at: params.createdAt,
      current_period_start: params.currentPeriodStart,
      current_period_end: params.currentPeriodEnd,
      credit_renewal_at: params.creditRenewalAt,
      cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
      transferred_to_subscription_id: params.transferredToSubscriptionId,
    });
  }

  it('lists only current personal subscription for the current user', async () => {
    const organization = await createOrganization('Subscription Center Org', user.id);
    const olderPersonalInstance = await createInstanceRow({
      userId: user.id,
      name: 'Older Personal',
      destroyedAt: '2026-04-01T00:00:00.000Z',
    });
    const newerPersonalInstance = await createInstanceRow({
      userId: user.id,
      name: 'Newer Personal',
    });
    const orgInstance = await createInstanceRow({
      userId: user.id,
      organizationId: organization.id,
      name: 'Org Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: newerPersonalInstance.id,
      paymentSource: 'credits',
      plan: 'commit',
      status: 'active',
      createdAt: '2026-04-02T00:00:00.000Z',
      creditRenewalAt: '2026-10-02T00:00:00.000Z',
    });
    const [newerCurrentRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, newerPersonalInstance.id))
      .limit(1);

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: olderPersonalInstance.id,
      stripeSubscriptionId: 'sub_personal_old',
      plan: 'standard',
      status: 'canceled',
      createdAt: '2026-04-01T00:00:00.000Z',
      transferredToSubscriptionId: newerCurrentRow?.id,
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: orgInstance.id,
      stripeSubscriptionId: 'sub_org_owned',
      plan: 'standard',
      status: 'active',
      createdAt: '2026-04-03T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.listPersonalSubscriptions();

    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0]).toMatchObject({
      instanceId: newerPersonalInstance.id,
      plan: 'commit',
      activationState: 'activated',
      paymentSource: 'credits',
      hasStripeFunding: false,
    });
  });

  it('returns detail for the requested personal subscription', async () => {
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Target Personal Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      paymentSource: 'credits',
      plan: 'standard',
      status: 'active',
      currentPeriodStart: '2026-04-01T00:00:00.000Z',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
      creditRenewalAt: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getSubscriptionDetail({
      instanceId: instance.id,
    });

    expect(result).toMatchObject({
      instanceId: instance.id,
      instanceName: 'Target Personal Instance',
      plan: 'standard',
      status: 'active',
      activationState: 'activated',
      paymentSource: 'credits',
      hasStripeFunding: false,
      creditRenewalAt: '2026-05-01T00:00:00.000Z',
    });
  });

  it('lists pending-settlement personal subscriptions with activationState', async () => {
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Pending Settlement Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_pending_list',
      paymentSource: 'stripe',
      plan: 'standard',
      status: 'active',
      currentPeriodStart: '2026-04-01T00:00:00.000Z',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.listPersonalSubscriptions();

    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0]).toMatchObject({
      instanceId: instance.id,
      plan: 'standard',
      status: 'active',
      activationState: 'pending_settlement',
      paymentSource: 'stripe',
      hasStripeFunding: true,
    });
  });

  it('preserves failure status for unpaid Stripe-backed personal subscriptions', async () => {
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Unpaid Stripe Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_unpaid_list',
      paymentSource: 'stripe',
      plan: 'standard',
      status: 'unpaid',
      currentPeriodStart: '2026-04-01T00:00:00.000Z',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.listPersonalSubscriptions();

    expect(result.subscriptions).toHaveLength(1);
    expect(result.subscriptions[0]).toMatchObject({
      instanceId: instance.id,
      plan: 'standard',
      status: 'unpaid',
      activationState: 'activated',
      paymentSource: 'stripe',
      hasStripeFunding: true,
    });
  });

  it('returns pending-settlement detail with activationState', async () => {
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Pending Settlement Detail',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_pending_detail',
      paymentSource: 'stripe',
      plan: 'standard',
      status: 'active',
      currentPeriodStart: '2026-04-01T00:00:00.000Z',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getSubscriptionDetail({
      instanceId: instance.id,
    });

    expect(result).toMatchObject({
      instanceId: instance.id,
      plan: 'standard',
      status: 'active',
      activationState: 'pending_settlement',
      paymentSource: 'stripe',
      hasStripeFunding: true,
    });
  });

  it('preserves failure status in detail for canceled Stripe-backed subscriptions', async () => {
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Canceled Stripe Detail',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_canceled_detail',
      paymentSource: 'stripe',
      plan: 'standard',
      status: 'canceled',
      currentPeriodStart: '2026-04-01T00:00:00.000Z',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getSubscriptionDetail({
      instanceId: instance.id,
    });

    expect(result).toMatchObject({
      instanceId: instance.id,
      plan: 'standard',
      status: 'canceled',
      activationState: 'activated',
      paymentSource: 'stripe',
      hasStripeFunding: true,
    });
  });

  it('rejects detail requests for org-owned instances', async () => {
    const organization = await createOrganization('Org Owned Detail', user.id);
    const instance = await createInstanceRow({
      userId: user.id,
      organizationId: organization.id,
      name: 'Org Detail Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_org_detail',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    await expect(
      caller.kiloclaw.getSubscriptionDetail({ instanceId: instance.id })
    ).rejects.toThrow('Subscription not found.');
  });

  it('lists Stripe billing history for the requested Stripe-funded instance', async () => {
    stripeMock.invoices.list.mockResolvedValue({
      data: [
        {
          id: 'inv_kiloclaw_1',
          created: 1_711_965_600,
          amount_due: 900,
          currency: 'usd',
          status: 'paid',
          hosted_invoice_url: 'https://stripe.example.test/inv_kiloclaw_1',
          invoice_pdf: 'https://stripe.example.test/inv_kiloclaw_1.pdf',
          lines: { data: [{ description: 'KiloClaw standard plan' }] },
        },
      ],
      has_more: false,
    });

    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Stripe Instance',
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_kiloclaw_stripe',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingHistory({
      instanceId: instance.id,
    });

    expect(stripeMock.invoices.list).toHaveBeenCalledWith({
      subscription: 'sub_kiloclaw_stripe',
      limit: 25,
    });
    expect(result).toEqual({
      entries: [
        {
          kind: 'stripe',
          id: 'inv_kiloclaw_1',
          date: new Date(1_711_965_600 * 1000).toISOString(),
          amountCents: 900,
          currency: 'usd',
          status: 'paid',
          invoiceUrl: 'https://stripe.example.test/inv_kiloclaw_1',
          invoicePdfUrl: 'https://stripe.example.test/inv_kiloclaw_1.pdf',
          description: 'KiloClaw standard plan',
        },
      ],
      hasMore: false,
      cursor: null,
    });
  });

  it('lists credit-funded billing history for the requested instance', async () => {
    const sandboxId = `sandbox-${crypto.randomUUID()}`;
    const oldInstance = await createInstanceRow({
      userId: user.id,
      name: 'Old Credits Instance',
      sandboxId,
      destroyedAt: '2026-04-15T00:00:00.000Z',
    });
    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Credits Instance',
      sandboxId,
    });
    const otherInstance = await createInstanceRow({
      userId: user.id,
      name: 'Other Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      paymentSource: 'credits',
      plan: 'standard',
      status: 'active',
      creditRenewalAt: '2026-06-01T00:00:00.000Z',
    });

    await db.insert(credit_transactions).values([
      {
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'Standard renewal',
        credit_category: `kiloclaw-subscription:${instance.id}:2026-04`,
        created_at: '2026-04-01T12:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -48_000_000,
        is_free: false,
        description: 'Commit renewal',
        credit_category: `kiloclaw-subscription-commit:${oldInstance.id}:2026-05`,
        created_at: '2026-05-01T12:00:00.000Z',
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: user.id,
        amount_microdollars: -9_000_000,
        is_free: false,
        description: 'Other instance renewal',
        credit_category: `kiloclaw-subscription:${otherInstance.id}:2026-06`,
        created_at: '2026-06-01T12:00:00.000Z',
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getBillingHistory({
      instanceId: instance.id,
    });

    expect(result).toEqual({
      entries: [
        {
          kind: 'credits',
          id: expect.any(String),
          date: '2026-05-01T12:00:00.000Z',
          amountMicrodollars: 48_000_000,
          description: 'Commit renewal',
        },
        {
          kind: 'credits',
          id: expect.any(String),
          date: '2026-04-01T12:00:00.000Z',
          amountMicrodollars: 9_000_000,
          description: 'Standard renewal',
        },
      ],
      hasMore: false,
      cursor: null,
    });
  });

  it('creates a customer portal session for the requested Stripe-funded instance', async () => {
    stripeMock.billingPortal.sessions.create.mockResolvedValue({
      url: 'https://stripe.example.test/kiloclaw-portal',
    });

    const instance = await createInstanceRow({
      userId: user.id,
      name: 'Portal Instance',
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: instance.id,
      stripeSubscriptionId: 'sub_kiloclaw_portal',
      plan: 'standard',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.getCustomerPortalUrl({
      instanceId: instance.id,
      returnUrl: 'https://example.test/subscriptions/kiloclaw',
    });

    expect(result).toEqual({
      url: 'https://stripe.example.test/kiloclaw-portal',
    });
    expect(stripeMock.billingPortal.sessions.create).toHaveBeenCalledWith({
      customer: user.stripe_customer_id,
      return_url: 'https://example.test/subscriptions/kiloclaw',
    });
  });

  it('cancels only the targeted instance subscription', async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({ schedule: null });
    stripeMock.subscriptions.update.mockResolvedValue({});

    const targetInstance = await createInstanceRow({
      userId: user.id,
      name: 'Target Instance',
    });
    const otherInstance = await createInstanceRow({
      userId: user.id,
      name: 'Other Instance',
    });

    await insertSubscriptionRow({
      userId: user.id,
      instanceId: targetInstance.id,
      stripeSubscriptionId: 'sub_target_instance',
      plan: 'standard',
      status: 'active',
    });
    await insertSubscriptionRow({
      userId: user.id,
      instanceId: otherInstance.id,
      stripeSubscriptionId: 'sub_other_instance',
      plan: 'commit',
      status: 'active',
    });

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelSubscriptionAtInstance({
      instanceId: targetInstance.id,
    });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptions.update).toHaveBeenCalledWith('sub_target_instance', {
      cancel_at_period_end: true,
    });

    const [targetRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, targetInstance.id))
      .limit(1);
    const [otherRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, otherInstance.id))
      .limit(1);

    expect(targetRow.cancel_at_period_end).toBe(true);
    expect(otherRow.cancel_at_period_end).toBe(false);

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, targetRow.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'canceled',
        reason: 'user_requested_cancellation',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        cancel_at_period_end: false,
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        cancel_at_period_end: true,
      })
    );
  });

  it('Stripe guard persists verified final boundary for lazy active-at-cutoff Commit', async () => {
    const instance = await createKiloclawInstance(user.id);
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        stripe_subscription_id: 'sub_lazy_commit_guard',
        payment_source: 'stripe',
        plan: 'commit',
        status: 'active',
        current_period_start: FINAL_COMMIT_START,
        current_period_end: FINAL_COMMIT_END,
        commit_ends_at: FINAL_COMMIT_END,
      })
      .returning();
    if (!subscription) throw new Error('Failed to insert lazy guard fixture');
    const liveSubscription = makeStripeSubscription({
      id: 'sub_lazy_commit_guard',
      metadata: { type: 'kiloclaw', plan: 'commit', kiloUserId: user.id },
      status: 'active',
      priceId: 'price_commit',
    });
    liveSubscription.schedule = null;
    liveSubscription.items.data[0]!.current_period_end = Math.floor(
      new Date(FINAL_COMMIT_END).getTime() / 1000
    );
    stripeMock.subscriptions.retrieve
      .mockResolvedValueOnce(liveSubscription)
      .mockResolvedValueOnce({
        ...liveSubscription,
        cancel_at_period_end: true,
      });
    stripeMock.subscriptions.update.mockResolvedValue({});
    const { enforceKiloClawCommitRetirementGuard } =
      await import('@/lib/kiloclaw/commit-retirement');

    await expect(
      enforceKiloClawCommitRetirementGuard({
        subscriptionId: subscription.id,
        expectedFinalBoundary: FINAL_COMMIT_END,
      })
    ).resolves.toEqual({ guarded: true });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(row).toEqual(
      expect.objectContaining({
        cancel_at_period_end: true,
      })
    );
  });

  it.each(['legacy', 'per-instance'] as const)(
    '%s undo clears continuation consent and conversion while preserving final-term evidence',
    async mutationPath => {
      setTestSystemTime('2026-06-07T00:00:00.000Z');
      const { instance } = await insertFinalCommitFixture();
      await db
        .update(kiloclaw_subscriptions)
        .set({
          scheduled_plan: 'standard',
          scheduled_by: 'user',
          pending_conversion: true,
          cancel_at_period_end: true,
        })
        .where(eq(kiloclaw_subscriptions.instance_id, instance.id));

      const caller = await createCallerForUser(user.id);
      const result =
        mutationPath === 'legacy'
          ? await caller.kiloclaw.cancelPlanSwitch()
          : await caller.kiloclaw.cancelPlanSwitchAtInstance({
              instanceId: instance.id,
            });

      expect(result).toEqual({ success: true });
      const [row] = await db
        .select()
        .from(kiloclaw_subscriptions)
        .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
      expect(row).toEqual(
        expect.objectContaining({
          scheduled_plan: null,
          pending_conversion: false,
          cancel_at_period_end: true,
        })
      );
    }
  );

  it('canceling pending Standard-to-Commit clears only pending retirement evidence', async () => {
    const instance = await createKiloclawInstance(user.id);
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      payment_source: 'credits',
      plan: 'standard',
      status: 'active',
      scheduled_plan: 'commit',
      scheduled_by: 'user',
      current_period_start: '2026-05-01T00:00:00.000Z',
      current_period_end: '2026-06-01T00:00:00.000Z',
      credit_renewal_at: '2026-06-01T00:00:00.000Z',
    });

    const caller = await createCallerForUser(user.id);
    await caller.kiloclaw.cancelPlanSwitchAtInstance({
      instanceId: instance.id,
    });

    const [row] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instance.id));
    expect(row).toEqual(
      expect.objectContaining({
        plan: 'standard',
        scheduled_plan: null,
      })
    );
  });

  it('writes changelog when canceling targeted instance plan switch', async () => {
    stripeMock.subscriptionSchedules.release.mockResolvedValue({});
    stripeMock.subscriptions.retrieve.mockResolvedValue({
      schedule: null,
      items: { data: [{ price: { id: 'price_standard' } }] },
    });

    const targetInstance = await createInstanceRow({
      userId: user.id,
      name: 'Target Instance',
    });
    const otherInstance = await createInstanceRow({
      userId: user.id,
      name: 'Other Instance',
    });

    await db.insert(kiloclaw_subscriptions).values([
      {
        user_id: user.id,
        instance_id: targetInstance.id,
        stripe_subscription_id: 'sub_target_cancel_switch',
        plan: 'standard',
        status: 'active',
        stripe_schedule_id: 'sched_target_cancel_switch',
        scheduled_plan: 'commit',
        scheduled_by: 'user',
      },
      {
        user_id: user.id,
        instance_id: otherInstance.id,
        stripe_subscription_id: 'sub_other_cancel_switch',
        plan: 'standard',
        status: 'active',
      },
    ]);

    const caller = await createCallerForUser(user.id);
    const result = await caller.kiloclaw.cancelPlanSwitchAtInstance({
      instanceId: targetInstance.id,
    });

    expect(result).toEqual({ success: true });
    expect(stripeMock.subscriptionSchedules.release).toHaveBeenCalledWith(
      'sched_target_cancel_switch'
    );

    const [targetRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, targetInstance.id))
      .limit(1);
    const [otherRow] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, otherInstance.id))
      .limit(1);

    expect(targetRow.stripe_schedule_id).toBeNull();
    expect(targetRow.scheduled_plan).toBeNull();
    expect(targetRow.scheduled_by).toBeNull();
    expect(otherRow.scheduled_plan).toBeNull();

    const logs = await db
      .select()
      .from(kiloclaw_subscription_change_log)
      .where(eq(kiloclaw_subscription_change_log.subscription_id, targetRow.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toEqual(
      expect.objectContaining({
        actor_type: 'user',
        actor_id: user.id,
        action: 'schedule_changed',
        reason: 'user_canceled_plan_switch',
      })
    );
    expect(logs[0]?.before_state).toEqual(
      expect.objectContaining({
        stripe_schedule_id: 'sched_target_cancel_switch',
        scheduled_plan: 'commit',
        scheduled_by: 'user',
      })
    );
    expect(logs[0]?.after_state).toEqual(
      expect.objectContaining({
        stripe_schedule_id: null,
        scheduled_plan: null,
        scheduled_by: null,
      })
    );
  });
});
