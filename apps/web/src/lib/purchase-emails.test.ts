process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

import { and, eq } from 'drizzle-orm';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import {
  credit_transactions,
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kilocode_users,
  transactional_email_log,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { processTopUp, resolveStripeReceiptUrl } from '@/lib/credits';
import {
  KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
  shouldSendSubscriptionStartedEmailForActivation,
} from '@/lib/kiloclaw/credit-billing';
import type * as creditBillingModule from '@/lib/kiloclaw/credit-billing';
import {
  renderTemplate,
  buildCreditsTopUpReceiptSection,
  subjects,
  sendCreditsTopUpEmail,
  sendKiloClawSubscriptionStartedEmail,
} from '@/lib/email';
import { processFirstTopupBonus } from '@/lib/firstTopupBonus';
import { grantCreditForCategory } from '@/lib/promotionalCredits';

jest.mock('@/lib/firstTopupBonus', () => ({
  processFirstTopupBonus: jest.fn(),
}));

jest.mock('@/lib/promotionalCredits', () => ({
  grantCreditForCategory: jest.fn(async () => ({
    success: true,
    message: 'ok',
    amount_usd: 1,
    credit_transaction_id: 'promo-credit-id',
  })),
}));

jest.mock('@/lib/kiloclaw/instance-lifecycle', () => ({
  autoResumeIfSuspended: jest.fn(async () => {}),
  clearTrialInactivityStopAfterTrialTransition: jest.fn(async () => {}),
}));

jest.mock('@/lib/kilo-pass/usage-triggered-bonus', () => ({
  computeUsageTriggeredMonthlyBonusDecision: jest.fn(() => ({ bonusPercentApplied: 0 })),
  maybeIssueKiloPassBonusFromUsageThreshold: jest.fn(async () => {}),
}));

jest.mock('@/lib/affiliate-events', () => ({
  enqueueAffiliateEventForUser: jest.fn(async () => {}),
  buildAffiliateEventDedupeKey: jest.fn(() => 'test-dedupe-key'),
  recordAffiliateAttributionAndQueueParentEvent: jest.fn(async () => {}),
}));

const processFirstTopupBonusMock = jest.mocked(processFirstTopupBonus);
const grantCreditForCategoryMock = jest.mocked(grantCreditForCategory);

type SendViaMailgunParams = { to: string; subject: string; html: string; replyTo?: string };
const sendViaMailgunMock = jest.fn<Promise<boolean>, [SendViaMailgunParams]>(async () => true);
const verifyEmailMock = jest.fn<Promise<boolean>, [string]>(async () => true);

jest.mock('@/lib/email-mailgun', () => ({
  sendViaMailgun: (params: SendViaMailgunParams) => sendViaMailgunMock(params),
}));

jest.mock('@/lib/email-neverbounce', () => ({
  verifyEmail: (email: string) => verifyEmailMock(email),
}));

jest.mock('@/lib/stripe-client', () => ({
  client: {
    charges: { retrieve: jest.fn(async () => ({ receipt_url: null })) },
    invoices: { retrieve: jest.fn(async () => ({ hosted_invoice_url: null })) },
    paymentIntents: { retrieve: jest.fn(async () => ({ latest_charge: null })) },
  },
}));

import { client as stripeClient } from '@/lib/stripe-client';

const stripeChargeRetrieveMock = jest.mocked(stripeClient.charges.retrieve);
const stripeInvoiceRetrieveMock = jest.mocked(stripeClient.invoices.retrieve);
const stripePaymentIntentRetrieveMock = jest.mocked(stripeClient.paymentIntents.retrieve);

describe('creditsTopUp template', () => {
  test('renders required fields', () => {
    const html = renderTemplate('creditsTopUp', {
      heading: 'Thanks for your top-up',
      intro: 'hello',
      amount_usd: '15.00',
      credits_usd: '15.00',
      purchase_date: 'January 1, 2026',
      credits_url: 'https://app.kilocode.ai/credits',
      receipt_section: buildCreditsTopUpReceiptSection('https://stripe.test/receipt'),
      year: '2026',
    });

    expect(html).toContain('Thanks for your top-up');
    expect(html).toContain('$15.00');
    expect(html).toContain('January 1, 2026');
    expect(html).toContain('https://app.kilocode.ai/credits');
    expect(html).toContain('https://stripe.test/receipt');
  });

  test('omits receipt section when receipt URL is missing', () => {
    const html = renderTemplate('creditsTopUp', {
      heading: 'h',
      intro: 'i',
      amount_usd: '5.00',
      credits_usd: '5.00',
      purchase_date: 'January 1, 2026',
      credits_url: 'https://app.kilocode.ai/credits',
      receipt_section: buildCreditsTopUpReceiptSection(null),
      year: '2026',
    });

    expect(html).not.toContain('View your Stripe receipt');
  });
});

describe('subjects map', () => {
  test('includes transactional purchase templates', () => {
    expect(subjects.creditsTopUp).toBeTruthy();
    expect(subjects.kiloClawSubscriptionStarted).toBeTruthy();
  });
});

describe('kiloClawSubscriptionStarted template', () => {
  test('renders required fields', () => {
    const html = renderTemplate('kiloClawSubscriptionStarted', {
      plan_name: 'KiloClaw Standard',
      price_usd: '9.00',
      billing_period: 'May 1, 2026 - June 1, 2026',
      next_billing_date: 'June 1, 2026',
      manage_url: 'https://app.kilocode.ai/claw/subscription',
      year: '2026',
    });

    expect(html).toContain('Your KiloClaw subscription is active');
    expect(html).toContain('KiloClaw Standard');
    expect(html).toContain('$9.00 USD');
    expect(html).toContain('May 1, 2026 - June 1, 2026');
    expect(html).toContain('June 1, 2026');
    expect(html).toContain('https://app.kilocode.ai/claw/subscription');
  });
});

const CREDITS_TOPUP_MANUAL_SUBJECT = subjects.creditsTopUp;
const CREDITS_TOPUP_AUTO_SUBJECT = 'Kilo auto top-up successful';

describe('processTopUp credit top-up email', () => {
  beforeEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
    processFirstTopupBonusMock.mockReset();
    grantCreditForCategoryMock.mockReset().mockResolvedValue({
      success: true,
      message: 'ok',
      amount_usd: 1,
      credit_transaction_id: 'promo-credit-id',
    });
  });

  afterEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
    processFirstTopupBonusMock.mockReset();
    grantCreditForCategoryMock.mockReset();
  });

  test('sends credit top-up email once for a successful manual top-up', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `ch_test_${Date.now()}_${Math.random()}`;
    const first = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(first).toBe(true);

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [topUpSend] = sendViaMailgunMock.mock.calls[0];
    expect(topUpSend.subject).toBe(CREDITS_TOPUP_MANUAL_SUBJECT);
    expect(topUpSend.html).toContain('$15.00 USD');
    expect(topUpSend.to).toBe(user.google_user_email);

    sendViaMailgunMock.mockClear();

    const second = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(second).toBe(false);
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
  });

  test('uses auto-top-up copy when isAutoTopUp is true', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    await processTopUp(
      user,
      2000,
      { type: 'stripe', stripe_payment_id: `ch_auto_${Date.now()}_${Math.random()}` },
      { isAutoTopUp: true }
    );

    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [autoSend] = sendViaMailgunMock.mock.calls[0];
    expect(autoSend.subject).toBe(CREDITS_TOPUP_AUTO_SUBJECT);
    expect(autoSend.html).toContain('Your auto top-up was successful');
    expect(autoSend.html).not.toContain('Thanks for your top-up');
  });

  test('does not send an email when skipPostTopUpFreeStuff is true', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    await processTopUp(
      user,
      1000,
      { type: 'stripe', stripe_payment_id: `ch_skip_${Date.now()}_${Math.random()}` },
      { skipPostTopUpFreeStuff: true }
    );

    expect(sendViaMailgunMock).not.toHaveBeenCalled();

    const [txn] = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id))
      .limit(1);
    expect(txn).toBeTruthy();
  });

  test('recovers confirmation email on webhook retry when first attempt did not send', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `ch_recover_${Date.now()}_${Math.random()}`;

    await db.insert(credit_transactions).values({
      id: crypto.randomUUID(),
      kilo_user_id: user.id,
      is_free: false,
      amount_microdollars: 1500 * 10_000,
      description: 'Top-up via stripe',
      original_baseline_microdollars_used: 0,
      stripe_payment_id: stripePaymentId,
    });

    const retry = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(retry).toBe(false);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);

    const [marker] = await db
      .select({ id: transactional_email_log.id })
      .from(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId))
      .limit(1);
    expect(marker).toBeTruthy();

    sendViaMailgunMock.mockClear();

    const thirdAttempt = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(thirdAttempt).toBe(false);
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
  });

  test('uses original credit transaction date when recovering a confirmation email', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `ch_recover_date_${Date.now()}_${Math.random()}`;
    const originalCreatedAt = '2026-01-07T08:30:00.000Z';

    await db.insert(credit_transactions).values({
      id: crypto.randomUUID(),
      kilo_user_id: user.id,
      is_free: false,
      amount_microdollars: 1500 * 10_000,
      description: 'Top-up via stripe',
      original_baseline_microdollars_used: 0,
      stripe_payment_id: stripePaymentId,
      created_at: originalCreatedAt,
    });

    const retry = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(retry).toBe(false);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [topUpSend] = sendViaMailgunMock.mock.calls[0];
    expect(topUpSend.html).toContain('January 7, 2026');
  });

  test('writes a transactional_email_log marker on first-attempt send', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `ch_marker_${Date.now()}_${Math.random()}`;
    const first = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(first).toBe(true);

    const [marker] = await db
      .select({ idempotency_key: transactional_email_log.idempotency_key })
      .from(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId))
      .limit(1);
    expect(marker).toEqual({ idempotency_key: stripePaymentId });
  });

  test('recovery path skips email when skipPostTopUpFreeStuff is true on retry', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `ch_skip_retry_${Date.now()}_${Math.random()}`;

    await db.insert(credit_transactions).values({
      id: crypto.randomUUID(),
      kilo_user_id: user.id,
      is_free: false,
      amount_microdollars: 1500 * 10_000,
      description: 'Top-up via stripe',
      original_baseline_microdollars_used: 0,
      stripe_payment_id: stripePaymentId,
    });

    const retry = await processTopUp(
      user,
      1500,
      { type: 'stripe', stripe_payment_id: stripePaymentId },
      { skipPostTopUpFreeStuff: true }
    );
    expect(retry).toBe(false);
    expect(sendViaMailgunMock).not.toHaveBeenCalled();

    const [marker] = await db
      .select({ id: transactional_email_log.id })
      .from(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId))
      .limit(1);
    expect(marker).toBeUndefined();
  });

  test('rolls back the credit transaction when the balance update fails before email recovery', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });

    const stripePaymentId = `ch_atomic_${Date.now()}_${Math.random()}`;

    await expect(
      db.transaction(async tx => {
        await tx.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
        await processTopUp(
          user,
          1500,
          { type: 'stripe', stripe_payment_id: stripePaymentId },
          { dbOrTx: tx }
        );
      })
    ).rejects.toThrow();

    await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));

    const [txnAfterRollback] = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.stripe_payment_id, stripePaymentId))
      .limit(1);
    expect(txnAfterRollback).toBeUndefined();

    const restoredUser = await insertTestUser(user);
    const retry = await processTopUp(restoredUser, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(retry).toBe(true);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);

    const [updatedUser] = await db
      .select({ total_microdollars_acquired: kilocode_users.total_microdollars_acquired })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, user.id))
      .limit(1);
    expect(updatedUser?.total_microdollars_acquired).toBe(1500 * 10_000);
  });

  test('sends confirmation email when first top-up bonus fails after credit commit', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    processFirstTopupBonusMock.mockRejectedValueOnce(new Error('bonus failed'));

    const stripePaymentId = `ch_bonus_failure_${Date.now()}_${Math.random()}`;
    const first = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });

    expect(first).toBe(true);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);

    const [marker] = await db
      .select({ idempotency_key: transactional_email_log.idempotency_key })
      .from(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId))
      .limit(1);
    expect(marker).toEqual({ idempotency_key: stripePaymentId });
  });

  test('sends auto top-up confirmation email when promo grant fails after credit commit', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
    });
    grantCreditForCategoryMock.mockRejectedValueOnce(new Error('promo failed'));

    const stripePaymentId = `ch_auto_promo_failure_${Date.now()}_${Math.random()}`;
    const first = await processTopUp(
      user,
      2000,
      { type: 'stripe', stripe_payment_id: stripePaymentId },
      { isAutoTopUp: true }
    );

    expect(first).toBe(true);
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [topUpSend] = sendViaMailgunMock.mock.calls[0];
    expect(topUpSend.subject).toBe(CREDITS_TOPUP_AUTO_SUBJECT);

    const [marker] = await db
      .select({ idempotency_key: transactional_email_log.idempotency_key })
      .from(transactional_email_log)
      .where(eq(transactional_email_log.idempotency_key, stripePaymentId))
      .limit(1);
    expect(marker).toEqual({ idempotency_key: stripePaymentId });
  });
});

describe('sendCreditsTopUpEmail payload', () => {
  beforeEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
  });

  test('manual variant emits the canonical subject, formatted amounts, and a receipt link', async () => {
    const result = await sendCreditsTopUpEmail({
      to: 'recipient@example.com',
      variant: 'manual',
      amountCents: 1500,
      creditsCents: 1500,
      purchaseDate: new Date('2026-01-15T12:00:00Z'),
      receiptUrl: 'https://pay.stripe.com/receipts/abc',
    });

    expect(result).toEqual({ sent: true });
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.to).toBe('recipient@example.com');
    expect(params.subject).toBe(subjects.creditsTopUp);
    expect(params.html).toContain('$15.00 USD');
    expect(params.html).toContain('January 15, 2026');
    expect(params.html).toContain('/credits');
    expect(params.html).toContain('https://pay.stripe.com/receipts/abc');
    expect(params.html).toContain('View your Stripe receipt');
  });

  test('auto variant overrides the subject and swaps the heading copy', async () => {
    await sendCreditsTopUpEmail({
      to: 'recipient@example.com',
      variant: 'auto',
      amountCents: 2000,
      creditsCents: 2000,
      purchaseDate: new Date('2026-02-01T00:00:00Z'),
      receiptUrl: null,
    });

    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.subject).toBe('Kilo auto top-up successful');
    expect(params.html).toContain('Your auto top-up was successful');
    expect(params.html).not.toContain('View your Stripe receipt');
  });

  test('null receipt URL renders an empty receipt section without breaking the template', async () => {
    await sendCreditsTopUpEmail({
      to: 'recipient@example.com',
      variant: 'manual',
      amountCents: 500,
      creditsCents: 500,
      purchaseDate: new Date('2026-03-01T00:00:00Z'),
      receiptUrl: null,
    });

    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.html).toContain('$5.00 USD');
    expect(params.html).not.toContain('View your Stripe receipt');
  });

  test('neverbounce rejection short-circuits before Mailgun is called', async () => {
    verifyEmailMock.mockImplementationOnce(async () => false);

    const result = await sendCreditsTopUpEmail({
      to: 'bad@example.com',
      variant: 'manual',
      amountCents: 1000,
      creditsCents: 1000,
      purchaseDate: new Date(),
      receiptUrl: null,
    });

    expect(result).toEqual({ sent: false, reason: 'neverbounce_rejected' });
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
  });

  test('mailgun misconfiguration surfaces as provider_not_configured', async () => {
    sendViaMailgunMock.mockImplementationOnce(async () => false);

    const result = await sendCreditsTopUpEmail({
      to: 'recipient@example.com',
      variant: 'manual',
      amountCents: 1000,
      creditsCents: 1000,
      purchaseDate: new Date(),
      receiptUrl: null,
    });

    expect(result).toEqual({ sent: false, reason: 'provider_not_configured' });
  });
});

describe('sendKiloClawSubscriptionStartedEmail payload', () => {
  beforeEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
  });

  test('emits canonical subject, formatted price/date, and manage subscription URL', async () => {
    const result = await sendKiloClawSubscriptionStartedEmail({
      to: 'recipient@example.com',
      planName: 'KiloClaw Standard',
      priceCents: 900,
      billingPeriod: 'May 1, 2026 - June 1, 2026',
      nextBillingDate: new Date('2026-06-01T00:00:00Z'),
    });

    expect(result).toEqual({ sent: true });
    expect(sendViaMailgunMock).toHaveBeenCalledTimes(1);
    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.to).toBe('recipient@example.com');
    expect(params.subject).toBe(subjects.kiloClawSubscriptionStarted);
    expect(params.html).toContain('KiloClaw Standard');
    expect(params.html).toContain('$9.00 USD');
    expect(params.html).toContain('June 1, 2026');
    expect(params.html).toContain('/claw/subscription');
  });

  test('zero-cent activation still renders a valid price', async () => {
    await sendKiloClawSubscriptionStartedEmail({
      to: 'recipient@example.com',
      planName: 'KiloClaw Standard',
      priceCents: 0,
      billingPeriod: 'May 1, 2026 - June 1, 2026',
      nextBillingDate: new Date('2026-06-01T00:00:00Z'),
    });

    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.html).toContain('$0.00 USD');
  });

  test('neverbounce rejection short-circuits before Mailgun is called', async () => {
    verifyEmailMock.mockImplementationOnce(async () => false);

    const result = await sendKiloClawSubscriptionStartedEmail({
      to: 'bad@example.com',
      planName: 'KiloClaw Standard',
      priceCents: 900,
      billingPeriod: 'May 1, 2026 - June 1, 2026',
      nextBillingDate: new Date('2026-06-01T00:00:00Z'),
    });

    expect(result).toEqual({ sent: false, reason: 'neverbounce_rejected' });
    expect(sendViaMailgunMock).not.toHaveBeenCalled();
  });

  test('mailgun misconfiguration surfaces as provider_not_configured', async () => {
    sendViaMailgunMock.mockImplementationOnce(async () => false);

    const result = await sendKiloClawSubscriptionStartedEmail({
      to: 'recipient@example.com',
      planName: 'KiloClaw Standard',
      priceCents: 900,
      billingPeriod: 'May 1, 2026 - June 1, 2026',
      nextBillingDate: new Date('2026-06-01T00:00:00Z'),
    });

    expect(result).toEqual({ sent: false, reason: 'provider_not_configured' });
  });
});

describe('KiloClaw subscription-started idempotency', () => {
  test('activation eligibility excludes renewals and dunning recovery', () => {
    expect(shouldSendSubscriptionStartedEmailForActivation('trialing')).toBe(true);
    expect(shouldSendSubscriptionStartedEmailForActivation('canceled')).toBe(true);
    expect(shouldSendSubscriptionStartedEmailForActivation('active')).toBe(false);
    expect(shouldSendSubscriptionStartedEmailForActivation('past_due')).toBe(false);
    expect(shouldSendSubscriptionStartedEmailForActivation('unpaid')).toBe(false);
    expect(shouldSendSubscriptionStartedEmailForActivation(null)).toBe(false);
  });

  test('email log dedupes webhook replays for the same activation period', async () => {
    const user = await insertTestUser({});
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();
    const periodStart = new Date().toISOString();

    const first = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
        period_start: periodStart,
      })
      .onConflictDoNothing();
    expect(first.rowCount).toBe(1);

    const replay = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
        period_start: periodStart,
      })
      .onConflictDoNothing();
    expect(replay.rowCount).toBe(0);
  });

  test('email log allows a new row for a later activation period', async () => {
    const user = await insertTestUser({});
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();
    const firstPeriodStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const secondPeriodStart = new Date().toISOString();

    const first = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
        period_start: firstPeriodStart,
      })
      .onConflictDoNothing();
    expect(first.rowCount).toBe(1);

    const second = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
        period_start: secondPeriodStart,
      })
      .onConflictDoNothing();
    expect(second.rowCount).toBe(1);

    const rows = await db
      .select({ id: kiloclaw_email_log.id })
      .from(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, user.id),
          eq(kiloclaw_email_log.instance_id, instance.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    expect(rows).toHaveLength(2);
  });
});

describe('applyStripeFundedKiloClawPeriod subscription-started email', () => {
  beforeEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
    processFirstTopupBonusMock.mockReset();
    grantCreditForCategoryMock.mockReset().mockResolvedValue({
      success: true,
      message: 'ok',
      amount_usd: 1,
      credit_transaction_id: 'promo-credit-id',
    });
  });

  afterEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
    processFirstTopupBonusMock.mockReset();
    grantCreditForCategoryMock.mockReset();
  });

  async function applyStripeFundedKiloClawPeriod(
    params: Parameters<typeof creditBillingModule.applyStripeFundedKiloClawPeriod>[0]
  ): Promise<boolean> {
    const mod = await import('@/lib/kiloclaw/credit-billing');
    return mod.applyStripeFundedKiloClawPeriod(params);
  }

  async function enrollWithCredits(
    params: Parameters<typeof creditBillingModule.enrollWithCredits>[0]
  ): Promise<void> {
    const mod = await import('@/lib/kiloclaw/credit-billing');
    return mod.enrollWithCredits(params);
  }

  async function seedSubscription(params: {
    userId: string;
    status: 'trialing' | 'canceled' | 'active' | 'past_due' | 'unpaid';
    plan: 'trial' | 'standard' | 'commit';
    stripeSubscriptionId: string;
  }) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: params.userId,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();
    const now = new Date();
    const [subscription] = await db
      .insert(kiloclaw_subscriptions)
      .values({
        user_id: params.userId,
        instance_id: instance.id,
        stripe_subscription_id: params.stripeSubscriptionId,
        payment_source: 'stripe',
        plan: params.plan,
        status: params.status,
        trial_started_at:
          params.plan === 'trial' ? new Date(now.getTime() - 14 * 86_400_000).toISOString() : null,
        trial_ends_at:
          params.plan === 'trial' ? new Date(now.getTime() - 7 * 86_400_000).toISOString() : null,
        current_period_start:
          params.plan !== 'trial' ? new Date(now.getTime() - 30 * 86_400_000).toISOString() : null,
        current_period_end:
          params.plan !== 'trial' ? new Date(now.getTime() - 1 * 86_400_000).toISOString() : null,
      })
      .returning();
    return { instance, subscription };
  }

  function countSubscriptionStartedSends(): number {
    return sendViaMailgunMock.mock.calls
      .map(([params]) => params)
      .filter(p => p.subject === subjects.kiloClawSubscriptionStarted).length;
  }

  async function countEmailLogRows(userId: string, instanceId: string): Promise<number> {
    const rows = await db
      .select({ id: kiloclaw_email_log.id })
      .from(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, userId),
          eq(kiloclaw_email_log.instance_id, instanceId),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    return rows.length;
  }

  async function seedCreditEnrollmentAnchor(userId: string) {
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: userId,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();
    await db.insert(kiloclaw_subscriptions).values({
      user_id: userId,
      instance_id: instance.id,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date().toISOString(),
      trial_ends_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    return instance;
  }

  test('trialing trial -> Stripe settlement sends one subscription-started email and writes the log row', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_trialing_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });

  test('trialing trial -> credit enrollment sends one subscription-started email and writes the log row', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 50_000_000 });
    const instance = await seedCreditEnrollmentAnchor(user.id);

    await enrollWithCredits({
      userId: user.id,
      instanceId: instance.id,
      plan: 'standard',
      hadPaidSubscription: false,
    });

    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);

    const [subscription] = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.instance_id, instance.id))
      .limit(1);
    const [emailLog] = await db
      .select()
      .from(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, user.id),
          eq(kiloclaw_email_log.instance_id, instance.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      )
      .limit(1);

    expect(emailLog?.period_start).toBe(subscription.current_period_start);
  });

  test('canceled trial -> Stripe settlement sends one subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_canceled_trial_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'canceled',
      plan: 'trial',
      stripeSubscriptionId,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });

  test('canceled paid row -> Stripe settlement sends one subscription-started email for resubscribe', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_canceled_paid_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'canceled',
      plan: 'standard',
      stripeSubscriptionId,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });

  test('$0 Stripe settlement still sends one subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_zero_amount_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `in_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 0,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
    const [zeroAmountSend] = sendViaMailgunMock.mock.calls.map(([params]) => params);
    expect(zeroAmountSend.html).toContain('$0.00 USD');
  });

  test('activate -> cancel -> resubscribe on same instance sends a second subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_resubscribe_${crypto.randomUUID()}`;
    const { instance, subscription } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_first_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      periodEnd: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    });
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);

    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();

    await db
      .update(kiloclaw_subscriptions)
      .set({ status: 'canceled' })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_second_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(2);
  });

  test('subscription.created before invoice.paid -> settlement still sends one subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_created_before_paid_${crypto.randomUUID()}`;
    const { instance, subscription } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    const periodStart = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const [activatedSubscription] = await db
      .update(kiloclaw_subscriptions)
      .set({
        status: 'active',
        plan: 'standard',
        current_period_start: periodStart,
        current_period_end: periodEnd,
      })
      .where(eq(kiloclaw_subscriptions.id, subscription.id))
      .returning();
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      actor: { actorType: 'system', actorId: 'stripe-webhook' },
      action: 'status_changed',
      reason: 'stripe_subscription_created',
      before: subscription,
      after: activatedSubscription,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart,
      periodEnd,
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });

  test('active renewal -> no subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_renewal_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'active',
      plan: 'standard',
      stripeSubscriptionId,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(0);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
  });

  test('past_due and unpaid recovery settlements do not send subscription-started email', async () => {
    for (const status of ['past_due', 'unpaid'] as const) {
      const user = await insertTestUser({});
      const stripeSubscriptionId = `sub_${status}_${crypto.randomUUID()}`;
      const { instance } = await seedSubscription({
        userId: user.id,
        status,
        plan: 'standard',
        stripeSubscriptionId,
      });

      const applied = await applyStripeFundedKiloClawPeriod({
        userId: user.id,
        metadataInstanceId: instance.id,
        stripeSubscriptionId,
        stripePaymentId: `ch_${crypto.randomUUID()}`,
        plan: 'standard',
        amountMicrodollars: 9_000_000,
        periodStart: new Date().toISOString(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      });

      expect(applied).toBe(true);
      expect(countSubscriptionStartedSends()).toBe(0);
      expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
    }
  });

  test('subscription.created log for a different period does not trigger a renewal email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_renewal_after_prior_${crypto.randomUUID()}`;
    const { instance, subscription } = await seedSubscription({
      userId: user.id,
      status: 'active',
      plan: 'standard',
      stripeSubscriptionId,
    });

    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      actor: { actorType: 'system', actorId: 'stripe-webhook' },
      action: 'status_changed',
      reason: 'stripe_subscription_created',
      before: { ...subscription, status: 'trialing' },
      after: subscription,
    });
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      actor: { actorType: 'system', actorId: 'kiloclaw-credit-billing' },
      action: 'period_advanced',
      reason: 'stripe_invoice_settlement',
      before: { ...subscription, status: 'trialing' },
      after: subscription,
    });

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(0);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
  });

  test('duplicate webhook replay does not send a second email when the log row already exists', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_replay_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });
    const periodStart = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const stripePaymentId = `ch_${crypto.randomUUID()}`;

    await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart,
      periodEnd,
    });
    expect(countSubscriptionStartedSends()).toBe(1);

    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();

    await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart,
      periodEnd,
    });

    expect(countSubscriptionStartedSends()).toBe(0);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });

  test('duplicate webhook recovery sends email once when durable activation log exists but email log is missing', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_recovery_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });
    const periodStart = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const stripePaymentId = `ch_${crypto.randomUUID()}`;

    await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart,
      periodEnd,
    });
    expect(countSubscriptionStartedSends()).toBe(1);

    await db
      .delete(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, user.id),
          eq(kiloclaw_email_log.instance_id, instance.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();

    await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart,
      periodEnd,
    });

    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });

  test('provider_not_configured clears email log row so a retry can re-attempt', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_provider_unconfigured_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });
    sendViaMailgunMock.mockImplementationOnce(async () => false);

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
  });

  test('neverbounce_rejected keeps email log row so terminal addresses do not retry', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_neverbounce_rejected_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });
    verifyEmailMock.mockImplementationOnce(async () => false);

    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: new Date().toISOString(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });

    expect(applied).toBe(true);
    expect(verifyEmailMock).toHaveBeenCalledWith(user.google_user_email);
    expect(countSubscriptionStartedSends()).toBe(0);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);
  });
});

describe('resolveStripeReceiptUrl', () => {
  beforeEach(() => {
    stripeChargeRetrieveMock.mockClear();
    stripeInvoiceRetrieveMock.mockClear();
    stripePaymentIntentRetrieveMock.mockClear();
  });

  test('resolves charge receipt URLs', async () => {
    stripeChargeRetrieveMock.mockResolvedValueOnce({
      receipt_url: 'https://pay.stripe.com/receipts/ch_test',
    } as Awaited<ReturnType<typeof stripeClient.charges.retrieve>>);

    await expect(resolveStripeReceiptUrl('ch_test', { skipInAutomatedTest: false })).resolves.toBe(
      'https://pay.stripe.com/receipts/ch_test'
    );

    expect(stripeChargeRetrieveMock).toHaveBeenCalledWith('ch_test');
  });

  test('resolves invoice hosted invoice URLs', async () => {
    stripeInvoiceRetrieveMock.mockResolvedValueOnce({
      hosted_invoice_url: 'https://invoice.stripe.com/i/in_test',
    } as Awaited<ReturnType<typeof stripeClient.invoices.retrieve>>);

    await expect(resolveStripeReceiptUrl('in_test', { skipInAutomatedTest: false })).resolves.toBe(
      'https://invoice.stripe.com/i/in_test'
    );

    expect(stripeInvoiceRetrieveMock).toHaveBeenCalledWith('in_test');
  });

  test('resolves expanded payment intent latest charge receipt URLs', async () => {
    stripePaymentIntentRetrieveMock.mockResolvedValueOnce({
      latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/pi_test' },
    } as Awaited<ReturnType<typeof stripeClient.paymentIntents.retrieve>>);

    await expect(resolveStripeReceiptUrl('pi_test', { skipInAutomatedTest: false })).resolves.toBe(
      'https://pay.stripe.com/receipts/pi_test'
    );

    expect(stripePaymentIntentRetrieveMock).toHaveBeenCalledWith('pi_test', {
      expand: ['latest_charge'],
    });
  });
});
