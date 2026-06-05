import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type * as StripeDisputesModule from '@/lib/stripe/disputes';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  auto_top_up_configs,
  credit_transactions,
  kilo_pass_subscriptions,
  kilocode_users,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  organization_seats_purchases,
  organizations,
  stripe_dispute_actions,
  stripe_dispute_cases,
} from '@kilocode/db/schema';
import {
  KiloPassCadence,
  KiloPassPaymentProvider,
  KiloPassTier,
  KiloClawPlan,
  KiloClawSubscriptionStatus,
  StripeDisputeActionStatus,
  StripeDisputeActionType,
  StripeDisputeCaseStatus,
  StripeDisputeOwnerClassification,
} from '@kilocode/db/schema-types';

jest.mock('@/lib/stripe-client', () => ({
  client: {
    disputes: { close: jest.fn(), retrieve: jest.fn() },
    invoices: { list: jest.fn() },
    invoicePayments: { list: jest.fn() },
    refunds: { create: jest.fn() },
    subscriptions: { cancel: jest.fn(), retrieve: jest.fn() },
    subscriptionSchedules: { release: jest.fn(), retrieve: jest.fn() },
    errors: { StripeInvalidRequestError: class StripeInvalidRequestError extends Error {} },
  },
}));

jest.mock('@/lib/ai-gateway/abuse-service', () => ({
  reportEvents: jest.fn(async () => undefined),
}));

jest.mock('@/lib/web-session-revocation', () => ({
  revokeWebSessions: jest.fn(async () => undefined),
}));

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const stopMock = jest.fn(async () => undefined);
  return {
    KiloClawInternalClient: jest.fn().mockImplementation(() => ({
      stop: stopMock,
    })),
    __stopMock: stopMock,
  };
});

type AnyMock = ReturnType<typeof jest.fn>;

const { acceptStripeDisputeCase, observeStripeDisputeCreated, stripeDisputeDashboardUrl } =
  jest.requireActual<typeof StripeDisputesModule>('@/lib/stripe/disputes');
const stripeClientMock = jest.requireMock('@/lib/stripe-client') as {
  client: {
    disputes: { close: AnyMock; retrieve: AnyMock };
    subscriptions: { cancel: AnyMock; retrieve: AnyMock };
    subscriptionSchedules: { release: AnyMock; retrieve: AnyMock };
  };
};
const { reportEvents } = jest.requireMock('@/lib/ai-gateway/abuse-service') as {
  reportEvents: AnyMock;
};
const { revokeWebSessions } = jest.requireMock('@/lib/web-session-revocation') as {
  revokeWebSessions: AnyMock;
};
const kiloclawClientMock = jest.requireMock('@/lib/kiloclaw/kiloclaw-internal-client') as {
  __stopMock: AnyMock;
};

const closeDisputeMock = stripeClientMock.client.disputes.close;
const retrieveDisputeMock = stripeClientMock.client.disputes.retrieve;
const cancelSubscriptionMock = stripeClientMock.client.subscriptions.cancel;
const retrieveSubscriptionMock = stripeClientMock.client.subscriptions.retrieve;
const releaseSubscriptionScheduleMock = stripeClientMock.client.subscriptionSchedules.release;
const stopKiloClawMock = kiloclawClientMock.__stopMock;
const reportEventsMock = reportEvents;
const revokeWebSessionsMock = revokeWebSessions;

beforeEach(async () => {
  await cleanupDbForTest();
  jest.clearAllMocks();
  cancelSubscriptionMock.mockResolvedValue({ id: 'sub_default' });
  retrieveSubscriptionMock.mockResolvedValue({ id: 'sub_default', schedule: null });
  releaseSubscriptionScheduleMock.mockResolvedValue({});
  stopKiloClawMock.mockResolvedValue(undefined);
});

describe('acceptStripeDisputeCase', () => {
  it('closes Stripe first, then blocks the user, disables auto top-up, resets credits, and records actions', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser({
      auto_top_up_enabled: true,
      total_microdollars_acquired: 1_500_000,
      microdollars_used: 500_000,
    });
    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: user.id,
      stripe_payment_method_id: 'pm_dispute_auto_top_up',
      amount_cents: 2000,
    });
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_accept_personal',
        stripe_event_id: 'evt_accept_personal',
        stripe_charge_id: 'ch_accept_personal',
        stripe_customer_id: user.stripe_customer_id,
        amount_minor_units: 2900,
        currency: 'usd',
        dispute_reason: 'fraudulent',
        stripe_status: 'needs_response',
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_accept_personal',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result).toEqual({ status: 'accepted', failures: [] });
    expect(closeDisputeMock).toHaveBeenCalledWith('dp_accept_personal');
    expect(revokeWebSessionsMock).toHaveBeenCalledWith(user.id);
    expect(reportEventsMock).toHaveBeenCalledWith({
      events: [
        {
          type: 'user.blocked',
          data: {
            kilo_user_id: user.id,
            reason: 'stripe_dispute_accepted:dp_accept_personal',
            actor_email: admin.google_user_email,
          },
        },
      ],
    });

    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase).toEqual(
      expect.objectContaining({
        status: StripeDisputeCaseStatus.Accepted,
        stripe_status: 'lost',
        accepted_by_kilo_user_id: admin.id,
      })
    );

    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser.blocked_reason).toBe('stripe_dispute_accepted:dp_accept_personal');
    expect(updatedUser.auto_top_up_enabled).toBe(false);
    expect(updatedUser.total_microdollars_acquired).toBe(updatedUser.microdollars_used);

    const [autoTopUpConfig] = await db.select().from(auto_top_up_configs);
    expect(autoTopUpConfig.disabled_reason).toBe('stripe_dispute_accepted:dp_accept_personal');

    const creditRows = await db.select().from(credit_transactions);
    expect(creditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kilo_user_id: user.id,
          amount_microdollars: -1_000_000,
          credit_category: 'stripe-dispute-enforcement',
        }),
      ])
    );

    const actions = await db.select().from(stripe_dispute_actions);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: StripeDisputeActionType.StripeAcceptance,
          status: StripeDisputeActionStatus.Completed,
          result_code: 'lost',
        }),
        expect.objectContaining({
          action_type: StripeDisputeActionType.UserBlock,
          status: StripeDisputeActionStatus.Completed,
          result_code: 'blocked',
        }),
        expect.objectContaining({
          action_type: StripeDisputeActionType.AutoTopUpDisable,
          status: StripeDisputeActionStatus.Completed,
          result_code: 'disabled',
        }),
        expect.objectContaining({
          action_type: StripeDisputeActionType.CreditBalanceReset,
          status: StripeDisputeActionStatus.Completed,
          result_code: 'reset',
        }),
        expect.objectContaining({
          action_type: StripeDisputeActionType.SubscriptionCancellation,
          status: StripeDisputeActionStatus.Skipped,
          result_code: 'no_subscription',
        }),
      ])
    );
  });

  it('does not run local enforcement when Stripe close fails', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_accept_failed',
        stripe_event_id: 'evt_accept_failed',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockRejectedValue(new Error('Stripe close failed'));

    await expect(acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin })).rejects.toThrow(
      'Stripe close failed'
    );

    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase.status).toBe(StripeDisputeCaseStatus.AcceptanceFailed);

    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser.blocked_reason).toBeNull();
    expect(revokeWebSessionsMock).not.toHaveBeenCalled();

    const actions = await db.select().from(stripe_dispute_actions);
    expect(actions).toEqual([
      expect.objectContaining({
        action_type: StripeDisputeActionType.StripeAcceptance,
        status: StripeDisputeActionStatus.Failed,
        failure_context: 'Stripe close failed',
      }),
    ]);
  });

  it('continues enforcement when retrying an already closed Stripe dispute', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const retryAt = new Date(Date.now() - 60 * 1000).toISOString();
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_already_closed_retry',
        stripe_event_id: 'evt_already_closed_retry',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.AcceptanceFailed,
        status_reason: 'Canonical personal owner matched; admin action required',
        next_retry_at: retryAt,
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockRejectedValue(new Error('This dispute has already been closed.'));
    retrieveDisputeMock.mockResolvedValue({
      id: 'dp_already_closed_retry',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result).toEqual({ status: 'accepted', failures: [] });
    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase.status).toBe(StripeDisputeCaseStatus.Accepted);
    expect(updatedCase.accepted_at).not.toBeNull();

    const actions = await db.select().from(stripe_dispute_actions);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: StripeDisputeActionType.StripeAcceptance,
          status: StripeDisputeActionStatus.Completed,
          result_code: 'lost',
        }),
        expect.objectContaining({
          action_type: StripeDisputeActionType.UserBlock,
          status: StripeDisputeActionStatus.Completed,
        }),
      ])
    );
  });

  it('does not enforce when an already closed Stripe dispute was not lost', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_already_closed_won',
        stripe_event_id: 'evt_already_closed_won',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockRejectedValue(new Error('This dispute has already been closed.'));
    retrieveDisputeMock.mockResolvedValue({
      id: 'dp_already_closed_won',
      status: 'won',
    } as Stripe.Response<Stripe.Dispute>);

    await expect(acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin })).rejects.toThrow(
      'Stripe dispute is already closed with status won; manual review required'
    );

    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase.status).toBe(StripeDisputeCaseStatus.AcceptanceFailed);
    const [updatedUser] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id));
    expect(updatedUser.blocked_reason).toBeNull();
    expect(revokeWebSessionsMock).not.toHaveBeenCalled();
  });

  it('fails enforcement when Kilo Pass is store-managed', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.AppStore,
      provider_subscription_id: 'app_store_dispute_subscription',
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
    });
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_store_managed_kilo_pass',
        stripe_event_id: 'evt_store_managed_kilo_pass',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_store_managed_kilo_pass',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result.status).toBe('enforcement_failed');
    expect(result.failures).toEqual(
      expect.arrayContaining(['Store-managed Kilo Pass subscription requires manual cancellation'])
    );
    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase.status).toBe(StripeDisputeCaseStatus.EnforcementFailed);

    const actions = await db.select().from(stripe_dispute_actions);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: StripeDisputeActionType.SubscriptionCancellation,
          target_key: 'personal_kilo_pass',
          status: StripeDisputeActionStatus.Failed,
          failure_context: 'Store-managed Kilo Pass subscription requires manual cancellation',
        }),
      ])
    );
  });

  it('reconciles Kilo Pass locally when Stripe subscription was already canceled', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    await db.insert(kilo_pass_subscriptions).values({
      kilo_user_id: user.id,
      payment_provider: KiloPassPaymentProvider.Stripe,
      provider_subscription_id: 'sub_kilo_pass_already_canceled',
      stripe_subscription_id: 'sub_kilo_pass_already_canceled',
      tier: KiloPassTier.Tier19,
      cadence: KiloPassCadence.Monthly,
      status: 'active',
    });
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_kilo_pass_already_canceled',
        stripe_event_id: 'evt_kilo_pass_already_canceled',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_kilo_pass_already_canceled',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);
    cancelSubscriptionMock.mockRejectedValueOnce(
      new Error('This subscription has already been canceled.')
    );

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result).toEqual({ status: 'accepted', failures: [] });
    const [subscription] = await db
      .select()
      .from(kilo_pass_subscriptions)
      .where(eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_kilo_pass_already_canceled'));
    expect(subscription.status).toBe('canceled');
    expect(subscription.ended_at).not.toBeNull();
  });

  it('allows stale processing cases to be retried', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const retryAt = new Date(Date.now() - 60 * 1000).toISOString();
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_processing_retry',
        stripe_event_id: 'evt_processing_retry',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.Processing,
        status_reason: 'Canonical personal owner matched; admin action required',
        acceptance_started_at: staleStartedAt,
        next_retry_at: retryAt,
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_processing_retry',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result).toEqual({ status: 'accepted', failures: [] });
    expect(closeDisputeMock).toHaveBeenCalledWith('dp_processing_retry');
  });

  it('rejects fresh processing cases', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_processing_fresh',
        stripe_event_id: 'evt_processing_fresh',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.Processing,
        status_reason: 'Canonical personal owner matched; admin action required',
        acceptance_started_at: new Date().toISOString(),
        next_retry_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      })
      .returning({ id: stripe_dispute_cases.id });

    await expect(acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin })).rejects.toThrow(
      'Dispute case is not actionable'
    );
    expect(closeDisputeMock).not.toHaveBeenCalled();
  });

  it('does not close Stripe when a personal case has lost its user link', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_missing_user_link',
        stripe_event_id: 'evt_missing_user_link',
        owner_classification: StripeDisputeOwnerClassification.Personal,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });

    await expect(acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin })).rejects.toThrow(
      'Dispute case owner link is missing'
    );
    expect(closeDisputeMock).not.toHaveBeenCalled();

    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase.status).toBe(StripeDisputeCaseStatus.ReviewRequired);
  });

  it('does not suspend organization-owned KiloClaw subscriptions for a personal dispute', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const organization = await createTestOrganization('Personal Dispute Org Scope', user.id, 0);
    const instanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      organization_id: organization.id,
      sandbox_id: `ki_${instanceId.replaceAll('-', '')}`,
    });
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        instance_id: instanceId,
        kiloclaw_price_version: '2026-05-10',
        plan: KiloClawPlan.Standard,
        status: KiloClawSubscriptionStatus.Active,
      })
      .returning({ id: kiloclaw_subscriptions.id });
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_personal_org_kiloclaw_scope',
        stripe_event_id: 'evt_personal_org_kiloclaw_scope',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_personal_org_kiloclaw_scope',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result).toEqual({ status: 'accepted', failures: [] });
    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
    const [updatedSubscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updatedSubscription.status).toBe(KiloClawSubscriptionStatus.Active);
    expect(updatedSubscription.destruction_deadline).toBeNull();

    const actions = await db.select().from(stripe_dispute_actions);
    expect(actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action_type: StripeDisputeActionType.KiloClawSuspension }),
      ])
    );
  });

  it('keeps KiloClaw suspension retryable when stopping compute fails', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const user = await insertTestUser();
    const instanceId = crypto.randomUUID();
    await db.insert(kiloclaw_instances).values({
      id: instanceId,
      user_id: user.id,
      sandbox_id: `ki_${instanceId.replaceAll('-', '')}`,
    });
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: user.id,
        stripe_subscription_id: 'sub_kiloclaw_stop_retry',
        instance_id: instanceId,
        kiloclaw_price_version: '2026-05-10',
        plan: KiloClawPlan.Standard,
        status: KiloClawSubscriptionStatus.Active,
      })
      .returning({ id: kiloclaw_subscriptions.id });
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_kiloclaw_stop_retry',
        stripe_event_id: 'evt_kiloclaw_stop_retry',
        stripe_customer_id: user.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: user.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_kiloclaw_stop_retry',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);
    stopKiloClawMock.mockRejectedValueOnce(new Error('stop failed'));

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result.status).toBe('enforcement_failed');
    expect(result.failures).toEqual(expect.arrayContaining(['stop failed']));
    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(stopKiloClawMock).toHaveBeenCalledTimes(1);

    const [updatedCase] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.id, caseRow.id));
    expect(updatedCase.status).toBe(StripeDisputeCaseStatus.EnforcementFailed);
    expect(updatedCase.next_retry_at).not.toBeNull();

    const [updatedSubscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.id, subscription.id));
    expect(updatedSubscription.status).toBe(KiloClawSubscriptionStatus.Canceled);
    expect(updatedSubscription.destruction_deadline).not.toBeNull();

    const actions = await db.select().from(stripe_dispute_actions);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: StripeDisputeActionType.KiloClawSuspension,
          status: StripeDisputeActionStatus.Failed,
          failure_context: 'stop failed',
        }),
      ])
    );

    const retryResult = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(retryResult).toEqual({ status: 'accepted', failures: [] });
    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(stopKiloClawMock).toHaveBeenCalledTimes(2);
    const retriedActions = await db.select().from(stripe_dispute_actions);
    expect(retriedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action_type: StripeDisputeActionType.KiloClawSuspension,
          status: StripeDisputeActionStatus.Completed,
          result_code: 'already_canceled',
        }),
      ])
    );
  });

  it('ends organization seat purchases and clears organization seat count', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const owner = await insertTestUser();
    const organization = await createTestOrganization(
      'Accepted Dispute Seat Org',
      owner.id,
      0,
      undefined,
      true
    );
    await db
      .update(organizations)
      .set({ seat_count: 5 })
      .where(eq(organizations.id, organization.id));
    await db.insert(organization_seats_purchases).values([
      {
        organization_id: organization.id,
        subscription_stripe_id: 'sub_disputed_org_seats',
        seat_count: 3,
        amount_usd: 216,
        starts_at: '2026-05-01T00:00:00.000Z',
        expires_at: '2026-06-01T00:00:00.000Z',
        subscription_status: 'active',
      },
      {
        organization_id: organization.id,
        subscription_stripe_id: 'sub_disputed_org_seats',
        seat_count: 5,
        amount_usd: 360,
        starts_at: '2026-06-01T00:00:00.000Z',
        expires_at: '2026-07-01T00:00:00.000Z',
        subscription_status: 'past_due',
      },
    ]);
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_accept_org_seats',
        stripe_event_id: 'evt_accept_org_seats',
        stripe_customer_id: organization.stripe_customer_id,
        owner_classification: StripeDisputeOwnerClassification.Organization,
        organization_id: organization.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical organization owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    closeDisputeMock.mockResolvedValue({
      id: 'dp_accept_org_seats',
      status: 'lost',
    } as Stripe.Response<Stripe.Dispute>);
    cancelSubscriptionMock.mockResolvedValue({ id: 'sub_disputed_org_seats' });
    retrieveSubscriptionMock.mockResolvedValueOnce({
      id: 'sub_disputed_org_seats',
      schedule: { id: 'sched_disputed_org_seats', status: 'active' },
    });

    const result = await acceptStripeDisputeCase({ caseId: caseRow.id, actor: admin });

    expect(result).toEqual({ status: 'accepted', failures: [] });
    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(releaseSubscriptionScheduleMock).toHaveBeenCalledWith('sched_disputed_org_seats');
    expect(cancelSubscriptionMock).toHaveBeenCalledWith('sub_disputed_org_seats', {
      invoice_now: false,
      prorate: false,
    });
    const updatedPurchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.subscription_stripe_id, 'sub_disputed_org_seats'));
    expect(updatedPurchases).toHaveLength(3);
    const endedPurchases = updatedPurchases.filter(
      purchase => purchase.subscription_status === 'ended'
    );
    const retainedPurchases = updatedPurchases.filter(
      purchase => purchase.subscription_status !== 'ended'
    );
    expect(endedPurchases).toEqual([
      expect.objectContaining({
        amount_usd: 0,
        seat_count: 0,
        subscription_status: 'ended',
      }),
    ]);
    expect(retainedPurchases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seat_count: 3, subscription_status: 'active' }),
        expect.objectContaining({ seat_count: 5, subscription_status: 'past_due' }),
      ])
    );
    const [updatedOrganization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(updatedOrganization.seat_count).toBe(0);

    const actions = await db.select().from(stripe_dispute_actions);
    expect(
      actions.filter(
        action =>
          action.action_type === StripeDisputeActionType.SubscriptionCancellation &&
          action.target_key === 'organization_seats_subscription:sub_disputed_org_seats'
      )
    ).toHaveLength(1);
  });
});

describe('stripeDisputeDashboardUrl', () => {
  it('uses the test dashboard prefix in development', () => {
    const nodeEnv = jest.replaceProperty(process.env, 'NODE_ENV', 'development');

    try {
      expect(stripeDisputeDashboardUrl('dp_test id')).toBe(
        'https://dashboard.stripe.com/test/disputes/dp_test%20id'
      );
    } finally {
      nodeEnv.restore();
    }
  });
});

describe('observeStripeDisputeCreated', () => {
  it('reopens review-required cases after a newer actionable observation', async () => {
    const user = await insertTestUser({ stripe_customer_id: 'cus_review_required_reopen_owner' });

    await observeStripeDisputeCreated({
      eventId: 'evt_dispute_under_review_first',
      eventCreated: 1_717_243_100,
      dispute: {
        id: 'dp_review_required_reopen',
        amount: 2900,
        charge: 'ch_review_required_reopen',
        created: 1_717_243_100,
        currency: 'usd',
        evidence_details: {
          due_by: null,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: 'pi_review_required_reopen',
        reason: 'fraudulent',
        status: 'under_review',
      },
      preFetchedCharge: {
        id: 'ch_review_required_reopen',
        customer: user.stripe_customer_id,
        payment_intent: 'pi_review_required_reopen',
      } as Stripe.Charge,
    });

    await observeStripeDisputeCreated({
      eventId: 'evt_dispute_needs_response_later',
      eventCreated: 1_717_243_200,
      dispute: {
        id: 'dp_review_required_reopen',
        amount: 2900,
        charge: 'ch_review_required_reopen',
        created: 1_717_243_100,
        currency: 'usd',
        evidence_details: {
          due_by: null,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: 'pi_review_required_reopen',
        reason: 'fraudulent',
        status: 'needs_response',
      },
      preFetchedCharge: {
        id: 'ch_review_required_reopen',
        customer: user.stripe_customer_id,
        payment_intent: 'pi_review_required_reopen',
      } as Stripe.Charge,
    });

    const [caseRow] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.stripe_dispute_id, 'dp_review_required_reopen'));
    expect(caseRow.status).toBe(StripeDisputeCaseStatus.NeedsAction);
    expect(caseRow.stripe_status).toBe('needs_response');
    expect(caseRow.stripe_event_id).toBe('evt_dispute_needs_response_later');
  });

  it('does not reopen review-required cases after an older actionable observation', async () => {
    const user = await insertTestUser({ stripe_customer_id: 'cus_review_required_dispute_owner' });

    await observeStripeDisputeCreated({
      eventId: 'evt_dispute_under_review',
      eventCreated: 1_717_243_200,
      dispute: {
        id: 'dp_review_required_no_reopen',
        amount: 2900,
        charge: 'ch_review_required_no_reopen',
        created: 1_717_243_200,
        currency: 'usd',
        evidence_details: {
          due_by: null,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: 'pi_review_required_no_reopen',
        reason: 'fraudulent',
        status: 'under_review',
      },
      preFetchedCharge: {
        id: 'ch_review_required_no_reopen',
        customer: user.stripe_customer_id,
        payment_intent: 'pi_review_required_no_reopen',
      } as Stripe.Charge,
    });

    await observeStripeDisputeCreated({
      eventId: 'evt_dispute_created_stale',
      eventCreated: 1_717_243_100,
      dispute: {
        id: 'dp_review_required_no_reopen',
        amount: 2900,
        charge: 'ch_review_required_no_reopen',
        created: 1_717_243_100,
        currency: 'usd',
        evidence_details: {
          due_by: null,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: 'pi_review_required_no_reopen',
        reason: 'fraudulent',
        status: 'needs_response',
      },
      preFetchedCharge: {
        id: 'ch_review_required_no_reopen',
        customer: user.stripe_customer_id,
        payment_intent: 'pi_review_required_no_reopen',
      } as Stripe.Charge,
    });

    const [caseRow] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.stripe_dispute_id, 'dp_review_required_no_reopen'));
    expect(caseRow.status).toBe(StripeDisputeCaseStatus.ReviewRequired);
    expect(caseRow.stripe_status).toBe('under_review');
    expect(caseRow.stripe_event_id).toBe('evt_dispute_under_review');
  });

  it('does not downgrade a terminal closed case after an older open observation', async () => {
    const user = await insertTestUser({ stripe_customer_id: 'cus_closed_dispute_owner' });

    await observeStripeDisputeCreated({
      eventId: 'evt_dispute_closed',
      eventCreated: 1_717_243_200,
      dispute: {
        id: 'dp_closed_no_reopen',
        amount: 2900,
        charge: 'ch_closed_no_reopen',
        created: 1_717_243_200,
        currency: 'usd',
        evidence_details: {
          due_by: null,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: 'pi_closed_no_reopen',
        reason: 'fraudulent',
        status: 'lost',
      },
      preFetchedCharge: {
        id: 'ch_closed_no_reopen',
        customer: user.stripe_customer_id,
        payment_intent: 'pi_closed_no_reopen',
      } as Stripe.Charge,
    });

    await observeStripeDisputeCreated({
      eventId: 'evt_dispute_created_older',
      eventCreated: 1_717_243_100,
      dispute: {
        id: 'dp_closed_no_reopen',
        amount: 2900,
        charge: 'ch_closed_no_reopen',
        created: 1_717_243_100,
        currency: 'usd',
        evidence_details: {
          due_by: null,
          enhanced_eligibility: {},
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        payment_intent: 'pi_closed_no_reopen',
        reason: 'fraudulent',
        status: 'needs_response',
      },
      preFetchedCharge: {
        id: 'ch_closed_no_reopen',
        customer: user.stripe_customer_id,
        payment_intent: 'pi_closed_no_reopen',
      } as Stripe.Charge,
    });

    const [caseRow] = await db
      .select()
      .from(stripe_dispute_cases)
      .where(eq(stripe_dispute_cases.stripe_dispute_id, 'dp_closed_no_reopen'));
    expect(caseRow.status).toBe(StripeDisputeCaseStatus.Closed);
    expect(caseRow.stripe_status).toBe('lost');
    expect(caseRow.stripe_event_id).toBe('evt_dispute_closed');
  });
});
