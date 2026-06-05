import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import type * as StripeDisputesModule from '@/lib/stripe/disputes';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  auto_top_up_configs,
  credit_transactions,
  kilocode_users,
  stripe_dispute_actions,
  stripe_dispute_cases,
} from '@kilocode/db/schema';
import {
  StripeDisputeActionStatus,
  StripeDisputeActionType,
  StripeDisputeCaseStatus,
  StripeDisputeOwnerClassification,
} from '@kilocode/db/schema-types';

jest.mock('@/lib/stripe-client', () => ({
  client: {
    disputes: { close: jest.fn() },
    invoices: { list: jest.fn() },
    invoicePayments: { list: jest.fn() },
    refunds: { create: jest.fn() },
    subscriptions: { cancel: jest.fn() },
    subscriptionSchedules: { release: jest.fn() },
    errors: { StripeInvalidRequestError: class StripeInvalidRequestError extends Error {} },
  },
}));

jest.mock('@/lib/ai-gateway/abuse-service', () => ({
  reportEvents: jest.fn(async () => undefined),
}));

jest.mock('@/lib/web-session-revocation', () => ({
  revokeWebSessions: jest.fn(async () => undefined),
}));

type AnyMock = ReturnType<typeof jest.fn>;

const { acceptStripeDisputeCase, observeStripeDisputeCreated } =
  jest.requireActual<typeof StripeDisputesModule>('@/lib/stripe/disputes');
const stripeClientMock = jest.requireMock('@/lib/stripe-client') as {
  client: { disputes: { close: AnyMock } };
};
const { reportEvents } = jest.requireMock('@/lib/ai-gateway/abuse-service') as {
  reportEvents: AnyMock;
};
const { revokeWebSessions } = jest.requireMock('@/lib/web-session-revocation') as {
  revokeWebSessions: AnyMock;
};

const closeDisputeMock = stripeClientMock.client.disputes.close;
const reportEventsMock = reportEvents;
const revokeWebSessionsMock = revokeWebSessions;

beforeEach(async () => {
  await cleanupDbForTest();
  jest.clearAllMocks();
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
});

describe('observeStripeDisputeCreated', () => {
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
