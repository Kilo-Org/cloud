import { eq } from 'drizzle-orm';
import { credit_transactions, kilocode_users, transactional_email_log } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { processTopUp, resolveStripeReceiptUrl } from '@/lib/credits';
import {
  renderTemplate,
  buildCreditsTopUpReceiptSection,
  subjects,
  sendCreditsTopUpEmail,
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
  test('includes the credits top-up template', () => {
    expect(subjects.creditsTopUp).toBeTruthy();
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
