import { describe, expect, it, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import type Stripe from 'stripe';

import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  kilo_pass_subscriptions,
  kilocode_users,
  user_admin_notes,
  credit_transactions,
} from '@kilocode/db/schema';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { eq } from 'drizzle-orm';

import { insertTestUser } from '@/tests/helpers/user.helper';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('@/lib/stripe-client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { errors } = require('stripe').default ?? require('stripe');
  const stripeMock = {
    subscriptions: {
      cancel: jest.fn(),
      retrieve: jest.fn(),
      update: jest.fn(),
    },
    subscriptionSchedules: {
      release: jest.fn(),
    },
    invoices: {
      list: jest.fn(),
    },
    invoicePayments: {
      list: jest.fn(),
    },
    refunds: {
      create: jest.fn(),
    },
    errors,
  };
  return { client: stripeMock, __stripeMock: stripeMock };
});

type AnyMock = ReturnType<typeof jest.fn>;
type StripeMock = {
  subscriptions: { cancel: AnyMock; retrieve: AnyMock; update: AnyMock };
  subscriptionSchedules: { release: AnyMock };
  invoices: { list: AnyMock };
  invoicePayments: { list: AnyMock };
  refunds: { create: AnyMock };
  errors: Stripe['errors'];
};

function getStripeMock(): StripeMock {
  const mod: { __stripeMock: StripeMock } = jest.requireMock('@/lib/stripe-client');
  return mod.__stripeMock;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createCallerForUser: (userId: string) => Promise<any>;

beforeAll(async () => {
  ({ createCallerForUser } = await import('@/routers/test-utils'));
});

async function insertActiveKiloPass(kiloUserId: string, stripeSubscriptionId: string) {
  const now = new Date().toISOString();
  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: kiloUserId,
    stripe_subscription_id: stripeSubscriptionId,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    status: 'active',
    cancel_at_period_end: false,
    current_streak_months: 1,
    started_at: now,
    ended_at: null,
    next_yearly_issue_at: null,
  });
}

async function insertCanceledKiloPass(kiloUserId: string, stripeSubscriptionId: string) {
  const now = new Date().toISOString();
  await db.insert(kilo_pass_subscriptions).values({
    kilo_user_id: kiloUserId,
    stripe_subscription_id: stripeSubscriptionId,
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
    status: 'canceled',
    cancel_at_period_end: false,
    current_streak_months: 0,
    started_at: now,
    ended_at: now,
    next_yearly_issue_at: null,
  });
}

function setupHappyPathStripe(stripe: StripeMock, opts?: { refundAmount?: number }) {
  stripe.subscriptions.cancel.mockResolvedValue({});
  stripe.invoices.list.mockResolvedValue({
    data: [{ id: 'in_test_123' }],
  });
  stripe.invoicePayments.list.mockResolvedValue({
    data: [{ payment: { payment_intent: 'pi_test_abc' } }],
  });
  stripe.refunds.create.mockResolvedValue({
    amount: opts?.refundAmount ?? 1900,
  });
}

function setupNoInvoiceStripe(stripe: StripeMock) {
  stripe.subscriptions.cancel.mockResolvedValue({});
  stripe.invoices.list.mockResolvedValue({ data: [] });
}

describe('admin.kiloPass.cancelAndRefundKiloPassBulk', () => {
  let adminUser: Awaited<ReturnType<typeof insertTestUser>>;

  beforeEach(async () => {
    await cleanupDbForTest();
    const stripeMock = getStripeMock();
    stripeMock.subscriptions.cancel.mockReset();
    stripeMock.subscriptions.retrieve.mockReset();
    stripeMock.subscriptions.update.mockReset();
    stripeMock.subscriptionSchedules.release.mockReset();
    stripeMock.invoices.list.mockReset();
    stripeMock.invoicePayments.list.mockReset();
    stripeMock.refunds.create.mockReset();

    adminUser = await insertTestUser({
      google_user_email: 'bulk-admin@example.com',
      is_admin: true,
    });
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  it('skips unknown emails without failing the batch', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({
      google_user_email: 'bulk-target-unknown-mix@example.com',
    });
    await insertActiveKiloPass(target.id, 'sub_unknown_mix');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-target-unknown-mix@example.com', 'does-not-exist@example.com'],
      reason: 'abuse',
    });

    expect(result.summary).toEqual({
      total: 2,
      cancelled: 1,
      skipped: 1,
      errored: 0,
      totalRefundedCents: 1900,
    });

    type Row = (typeof result.results)[number];
    const byEmail = new Map<string, Row>(result.results.map((r: Row) => [r.email, r]));
    expect(byEmail.get('bulk-target-unknown-mix@example.com')?.status).toBe(
      'cancelled_and_refunded'
    );
    expect(byEmail.get('does-not-exist@example.com')?.status).toBe('skipped_no_user');
    expect(byEmail.get('does-not-exist@example.com')?.userId).toBeNull();
  });

  it('skips users with no Kilo Pass subscription', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({ google_user_email: 'bulk-no-sub@example.com' });

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-no-sub@example.com'],
      reason: 'abuse',
    });

    expect(result.summary.skipped).toBe(1);
    expect(result.summary.cancelled).toBe(0);
    expect(result.results[0].status).toBe('skipped_no_subscription');
    expect(result.results[0].userId).toBe(target.id);
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('skips users whose subscription is already canceled', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({
      google_user_email: 'bulk-already-canceled@example.com',
    });
    await insertCanceledKiloPass(target.id, 'sub_already_canceled');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-already-canceled@example.com'],
      reason: 'abuse',
    });

    expect(result.summary.skipped).toBe(1);
    expect(result.results[0].status).toBe('skipped_already_canceled');
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
  });

  it('treats charge_already_refunded as a successful cancellation with no refund', async () => {
    const stripeMock = getStripeMock();
    stripeMock.subscriptions.cancel.mockResolvedValue({});
    stripeMock.invoices.list.mockResolvedValue({ data: [{ id: 'in_already_refunded' }] });
    stripeMock.invoicePayments.list.mockResolvedValue({
      data: [{ payment: { payment_intent: 'pi_already_refunded' } }],
    });
    const alreadyRefundedError = new stripeMock.errors.StripeInvalidRequestError({
      message: 'charge_already_refunded',
      type: 'invalid_request_error',
      code: 'charge_already_refunded',
    });
    stripeMock.refunds.create.mockRejectedValue(alreadyRefundedError);

    const target = await insertTestUser({
      google_user_email: 'bulk-already-refunded@example.com',
    });
    await insertActiveKiloPass(target.id, 'sub_already_refunded');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-already-refunded@example.com'],
      reason: 'chargeback',
    });

    expect(result.summary).toEqual({
      total: 1,
      cancelled: 1,
      skipped: 0,
      errored: 0,
      totalRefundedCents: 0,
    });
    expect(result.results[0].status).toBe('cancelled_and_refunded');
    expect(result.results[0].refundedAmountCents).toBeNull();

    const row = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_already_refunded'),
    });
    expect(row?.status).toBe('canceled');
  });

  it('cancels, refunds, blocks and notes end-to-end for a happy-path user', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({
      google_user_email: 'bulk-happy-path@example.com',
      total_microdollars_acquired: 5_000_000,
      microdollars_used: 1_000_000,
    });
    await insertActiveKiloPass(target.id, 'sub_happy_path');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-happy-path@example.com'],
      reason: 'fraud-ring',
    });

    expect(result.summary).toEqual({
      total: 1,
      cancelled: 1,
      skipped: 0,
      errored: 0,
      totalRefundedCents: 1900,
    });

    const row = result.results[0];
    expect(row.status).toBe('cancelled_and_refunded');
    expect(row.refundedAmountCents).toBe(1900);
    expect(row.balanceResetAmountUsd).toBeCloseTo(4, 5);
    expect(row.alreadyBlocked).toBe(false);

    // Subscription updated
    const subRow = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_happy_path'),
    });
    expect(subRow?.status).toBe('canceled');
    expect(subRow?.current_streak_months).toBe(0);

    // User blocked
    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, target.id),
    });
    expect(userRow?.blocked_reason).toBe('fraud-ring');
    expect(userRow?.blocked_by_kilo_user_id).toBe(adminUser.id);
    expect(userRow?.total_microdollars_acquired).toBe(1_000_000);

    // Balance-zero credit transaction inserted
    const txnRows = await db.query.credit_transactions.findMany({
      where: eq(credit_transactions.kilo_user_id, target.id),
    });
    expect(txnRows).toHaveLength(1);
    expect(txnRows[0].amount_microdollars).toBe(-4_000_000);
    expect(txnRows[0].credit_category).toBe('admin-cancel-refund-kilo-pass');

    // Admin note inserted with [bulk] suffix
    const noteRows = await db.query.user_admin_notes.findMany({
      where: eq(user_admin_notes.kilo_user_id, target.id),
    });
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0].note_content).toContain('Reason: fraud-ring');
    expect(noteRows[0].note_content).toContain('Refunded: $19.00');
    expect(noteRows[0].note_content).toContain('Balance reset: $4.00 zeroed.');
    expect(noteRows[0].note_content).toContain('Account blocked.');
    expect(noteRows[0].note_content).toContain('[bulk]');
  });

  it('handles no-invoice users as cancelled with null refund', async () => {
    const stripeMock = getStripeMock();
    setupNoInvoiceStripe(stripeMock);

    const target = await insertTestUser({ google_user_email: 'bulk-no-invoice@example.com' });
    await insertActiveKiloPass(target.id, 'sub_no_invoice');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-no-invoice@example.com'],
      reason: 'policy',
    });

    expect(result.summary.cancelled).toBe(1);
    expect(result.summary.totalRefundedCents).toBe(0);
    expect(result.results[0].refundedAmountCents).toBeNull();
  });

  it('continues the batch when one user throws; committed users stay committed', async () => {
    const stripeMock = getStripeMock();
    // First user: succeeds. Second user: throws on stripe cancel. Third user: succeeds.
    stripeMock.subscriptions.cancel
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Stripe boom'))
      .mockResolvedValueOnce({});
    stripeMock.invoices.list.mockResolvedValue({ data: [{ id: 'in_x' }] });
    stripeMock.invoicePayments.list.mockResolvedValue({
      data: [{ payment: { payment_intent: 'pi_x' } }],
    });
    stripeMock.refunds.create.mockResolvedValue({ amount: 1900 });

    const u1 = await insertTestUser({ google_user_email: 'bulk-seq-1@example.com' });
    const u2 = await insertTestUser({ google_user_email: 'bulk-seq-2@example.com' });
    const u3 = await insertTestUser({ google_user_email: 'bulk-seq-3@example.com' });
    await insertActiveKiloPass(u1.id, 'sub_seq_1');
    await insertActiveKiloPass(u2.id, 'sub_seq_2');
    await insertActiveKiloPass(u3.id, 'sub_seq_3');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-seq-1@example.com', 'bulk-seq-2@example.com', 'bulk-seq-3@example.com'],
      reason: 'mixed-batch',
    });

    expect(result.summary).toEqual({
      total: 3,
      cancelled: 2,
      skipped: 0,
      errored: 1,
      totalRefundedCents: 3800,
    });

    type Row = (typeof result.results)[number];
    const byEmail = new Map<string, Row>(result.results.map((r: Row) => [r.email, r]));
    expect(byEmail.get('bulk-seq-1@example.com')?.status).toBe('cancelled_and_refunded');
    expect(byEmail.get('bulk-seq-2@example.com')?.status).toBe('error');
    expect(byEmail.get('bulk-seq-2@example.com')?.error).toContain('Stripe boom');
    expect(byEmail.get('bulk-seq-3@example.com')?.status).toBe('cancelled_and_refunded');

    // u1 and u3 are committed (blocked); u2 is NOT blocked (rolled back before tx)
    const u1Row = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, u1.id),
    });
    const u2Row = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, u2.id),
    });
    const u3Row = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, u3.id),
    });
    expect(u1Row?.blocked_reason).toBe('mixed-batch');
    expect(u2Row?.blocked_reason).toBeNull();
    expect(u3Row?.blocked_reason).toBe('mixed-batch');

    // Subscriptions for successful users are canceled; the failed user's sub is unchanged
    const sub1 = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_seq_1'),
    });
    const sub2 = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_seq_2'),
    });
    const sub3 = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_seq_3'),
    });
    expect(sub1?.status).toBe('canceled');
    expect(sub2?.status).toBe('active');
    expect(sub3?.status).toBe('canceled');
  });

  it('deduplicates emails case-insensitively before iterating', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({ google_user_email: 'bulk-dedupe@example.com' });
    await insertActiveKiloPass(target.id, 'sub_dedupe');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-dedupe@example.com', 'BULK-DEDUPE@example.com', 'bulk-dedupe@example.com'],
      reason: 'dedupe',
    });

    expect(result.summary.total).toBe(1);
    expect(result.summary.cancelled).toBe(1);
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not re-block users who were already blocked', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({
      google_user_email: 'bulk-already-blocked@example.com',
      blocked_reason: 'previous-block',
      blocked_at: new Date().toISOString(),
    });
    await insertActiveKiloPass(target.id, 'sub_already_blocked');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-already-blocked@example.com'],
      reason: 'new-reason',
    });

    expect(result.results[0].status).toBe('cancelled_and_refunded');
    expect(result.results[0].alreadyBlocked).toBe(true);

    const userRow = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, target.id),
    });
    expect(userRow?.blocked_reason).toBe('previous-block');
  });

  it('matches stored mixed-case emails case-insensitively', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const target = await insertTestUser({
      google_user_email: 'Bulk-MixedCase@Example.com',
    });
    await insertActiveKiloPass(target.id, 'sub_mixed_case');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['bulk-mixedcase@example.com'],
      reason: 'case-insensitive',
    });

    expect(result.summary.cancelled).toBe(1);
    expect(result.results[0].status).toBe('cancelled_and_refunded');
    expect(result.results[0].userId).toBe(target.id);
  });

  it('errors on ambiguous case-only duplicates without touching either account', async () => {
    const stripeMock = getStripeMock();
    setupHappyPathStripe(stripeMock);

    const u1 = await insertTestUser({ google_user_email: 'Ambiguous@example.com' });
    const u2 = await insertTestUser({ google_user_email: 'ambiguous@example.com' });
    await insertActiveKiloPass(u1.id, 'sub_ambig_1');
    await insertActiveKiloPass(u2.id, 'sub_ambig_2');

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.kiloPass.cancelAndRefundKiloPassBulk({
      emails: ['ambiguous@example.com'],
      reason: 'ambiguity',
    });

    expect(result.summary).toEqual({
      total: 1,
      cancelled: 0,
      skipped: 0,
      errored: 1,
      totalRefundedCents: 0,
    });
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toContain('Multiple accounts match');

    // Neither subscription was canceled
    const sub1 = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_ambig_1'),
    });
    const sub2 = await db.query.kilo_pass_subscriptions.findFirst({
      where: eq(kilo_pass_subscriptions.stripe_subscription_id, 'sub_ambig_2'),
    });
    expect(sub1?.status).toBe('active');
    expect(sub2?.status).toBe('active');
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
  });
});
