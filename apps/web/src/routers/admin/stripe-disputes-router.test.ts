import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as StripeDisputesModule from '@/lib/stripe/disputes';
import type * as StripeDisputesRouterModule from '@/routers/admin/stripe-disputes-router';
import type * as TestUtilsModule from '@/routers/test-utils';

import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  admin_action_audit_logs,
  organizations,
  stripe_dispute_actions,
  stripe_dispute_cases,
  type User,
} from '@kilocode/db/schema';
import {
  StripeDisputeActionStatus,
  StripeDisputeActionType,
  StripeDisputeCaseStatus,
  StripeDisputeOwnerClassification,
} from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
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

jest.mock('@kilocode/web-shared/lib/web-session-revocation', () => ({
  revokeWebSessions: jest.fn(async () => undefined),
}));

async function adminAuditRows(actorId: string) {
  return db
    .select({
      action: admin_action_audit_logs.action,
      outcome: admin_action_audit_logs.outcome,
      target_type: admin_action_audit_logs.target_type,
      target_id: admin_action_audit_logs.target_id,
      metadata: admin_action_audit_logs.metadata,
    })
    .from(admin_action_audit_logs)
    .where(eq(admin_action_audit_logs.actor_id, actorId));
}

let StripeDisputeCaseActionError: typeof StripeDisputesModule.StripeDisputeCaseActionError;
let disputeAcceptTRPCError: typeof StripeDisputesRouterModule.disputeAcceptTRPCError;
let createCallerForUser: typeof TestUtilsModule.createCallerForUser;

beforeAll(async () => {
  ({ StripeDisputeCaseActionError } = await import('@/lib/stripe/disputes'));
  ({ disputeAcceptTRPCError } = await import('@/routers/admin/stripe-disputes-router'));
  ({ createCallerForUser } = await import('@/routers/test-utils'));
});

let admin: User;
let nonAdmin: User;
let personalOwner: User;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `admin-disputes-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
  nonAdmin = await insertTestUser({
    google_user_email: `non-admin-disputes-${Math.random()}@example.com`,
  });
  personalOwner = await insertTestUser({
    google_user_email: `personal-disputes-${Math.random()}@example.com`,
  });
});

describe('admin disputes router', () => {
  it('rejects non-admin users', async () => {
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(caller.admin.disputes.list({ page: 1, limit: 25 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('maps admin-actionable accept errors to bad request', () => {
    const error = disputeAcceptTRPCError(
      new StripeDisputeCaseActionError('Dispute case is not actionable')
    );

    expect(error.code).toBe('BAD_REQUEST');
    expect(error.message).toBe('Dispute case is not actionable');
  });

  it('maps unexpected accept failures to internal server error', () => {
    const error = disputeAcceptTRPCError(new Error('Stripe close failed'));

    expect(error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(error.message).toBe('Stripe close failed');
  });

  it('lists dispute cases with owner joins, filters, and action history', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Disputed Org', stripe_customer_id: 'cus_disputed_org' })
      .returning();
    const [personalCase] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_personal_list',
        stripe_event_id: 'evt_personal_list',
        stripe_charge_id: 'ch_personal_list',
        stripe_payment_intent_id: 'pi_personal_list',
        stripe_customer_id: personalOwner.stripe_customer_id,
        amount_minor_units: 2900,
        currency: 'usd',
        dispute_reason: 'fraudulent',
        stripe_status: 'needs_response',
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: personalOwner.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
        stripe_created_at: '2026-05-28 10:11:12.123+00',
        evidence_due_by: '2026-05-29 10:11:12.123+00',
        synced_at: '2026-05-28 10:12:12.123+00',
      })
      .returning({ id: stripe_dispute_cases.id });
    await db.insert(stripe_dispute_cases).values({
      stripe_dispute_id: 'dp_org_list',
      stripe_event_id: 'evt_org_list',
      stripe_charge_id: 'ch_org_list',
      stripe_customer_id: 'cus_disputed_org',
      amount_minor_units: 7200,
      currency: 'usd',
      dispute_reason: 'general',
      stripe_status: 'warning_needs_response',
      owner_classification: StripeDisputeOwnerClassification.Organization,
      organization_id: organization.id,
      status: StripeDisputeCaseStatus.ReviewRequired,
      status_reason: 'Manual organization review required',
      stripe_created_at: '2026-05-27 10:11:12.123+00',
      evidence_due_by: '2026-05-30 10:11:12.123+00',
      synced_at: '2026-05-27 10:12:12.123+00',
    });
    await db.insert(stripe_dispute_actions).values({
      case_id: personalCase.id,
      action_type: StripeDisputeActionType.StripeAcceptance,
      target_key: 'stripe_dispute:dp_personal_list',
      status: StripeDisputeActionStatus.Completed,
      attempt_count: 1,
      completed_at: '2026-05-28 10:13:12.123+00',
      result_code: 'lost',
      result_reference_id: 'dp_personal_list',
    });

    const caller = await createCallerForUser(admin.id);
    const summary = await caller.admin.disputes.summary();
    const needsAction = await caller.admin.disputes.list({ page: 1, limit: 25 });
    const organizationReview = await caller.admin.disputes.list({
      page: 1,
      limit: 25,
      status: 'review_required',
      ownerClassification: 'organization',
    });

    expect(summary).toEqual({ pendingCount: 1 });
    expect(needsAction.pagination).toEqual({ page: 1, limit: 25, total: 1, totalPages: 1 });
    expect(needsAction.rows[0]).toEqual(
      expect.objectContaining({
        stripeDisputeId: 'dp_personal_list',
        ownerClassification: 'personal',
        status: 'needs_action',
        stripeCreatedAt: '2026-05-28T10:11:12.123Z',
        evidenceDueBy: '2026-05-29T10:11:12.123Z',
        user: {
          id: personalOwner.id,
          email: personalOwner.google_user_email,
          name: personalOwner.google_user_name,
        },
      })
    );
    expect(needsAction.rows[0]?.actions[0]).toEqual(
      expect.objectContaining({
        actionType: 'stripe_acceptance',
        status: 'completed',
        completedAt: '2026-05-28T10:13:12.123Z',
      })
    );
    expect(organizationReview.rows).toHaveLength(1);
    expect(organizationReview.rows[0]).toEqual(
      expect.objectContaining({
        stripeDisputeId: 'dp_org_list',
        ownerClassification: 'organization',
        organization: { id: organization.id, name: 'Disputed Org' },
        user: null,
      })
    );
  });

  it('records the accepting admin and the dispute case in the admin audit log', async () => {
    const [caseRow] = await db
      .insert(stripe_dispute_cases)
      .values({
        stripe_dispute_id: 'dp_accept_audit',
        stripe_event_id: 'evt_accept_audit',
        stripe_charge_id: 'ch_accept_audit',
        stripe_customer_id: personalOwner.stripe_customer_id,
        amount_minor_units: 2900,
        currency: 'usd',
        dispute_reason: 'fraudulent',
        stripe_status: 'needs_response',
        owner_classification: StripeDisputeOwnerClassification.Personal,
        kilo_user_id: personalOwner.id,
        status: StripeDisputeCaseStatus.NeedsAction,
        status_reason: 'Canonical personal owner matched; admin action required',
      })
      .returning({ id: stripe_dispute_cases.id });
    const { client } = jest.requireMock('@kilocode/web-shared/lib/stripe-client') as {
      client: { disputes: { close: jest.Mock<() => Promise<unknown>> } };
    };
    client.disputes.close.mockResolvedValue({ id: 'dp_accept_audit', status: 'lost' });
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.disputes.accept({ caseId: caseRow.id })).resolves.toEqual({
      status: 'accepted',
      failures: [],
    });

    expect(await adminAuditRows(admin.id)).toEqual([
      {
        action: 'stripe_dispute.accept',
        outcome: 'success',
        target_type: 'stripe_dispute',
        target_id: caseRow.id,
        metadata: { status: 'accepted', failureCount: 0 },
      },
    ]);
  });

  it('records a failure row when the dispute case cannot be accepted', async () => {
    const caseId = crypto.randomUUID();
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.disputes.accept({ caseId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    expect(await adminAuditRows(admin.id)).toEqual([
      {
        action: 'stripe_dispute.accept',
        outcome: 'failure',
        target_type: 'stripe_dispute',
        target_id: caseId,
        metadata: { errorCode: 'BAD_REQUEST' },
      },
    ]);
  });
});
