import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { eq, and } from 'drizzle-orm';
import { credit_transactions, kiloclaw_email_log } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { processTopUp } from '@/lib/credits';
import { KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE } from '@/lib/kiloclaw/credit-billing';
import type * as emailModule from '@/lib/email';
import {
  renderTemplate,
  buildCreditsTopUpReceiptSection,
  subjects,
  type TemplateName,
} from '@/lib/email';

// Avoid firstTopupBonus side effects.
jest.mock('@/lib/firstTopupBonus', () => ({
  processFirstTopupBonus: jest.fn(),
}));

// Count email sends via the shared `send` export.
const sendMock = jest.fn(async (_params: unknown) => ({ sent: true as const }));

jest.mock('@/lib/email', () => {
  const actual = jest.requireActual<typeof emailModule>('@/lib/email');
  return {
    ...actual,
    send: jest.fn((params: unknown) => sendMock(params)),
  };
});

// Receipt URL lookups during unit tests must not touch Stripe.
jest.mock('@/lib/stripe-client', () => ({
  client: {
    charges: { retrieve: jest.fn(async () => ({ receipt_url: null })) },
    invoices: { retrieve: jest.fn(async () => ({ hosted_invoice_url: null })) },
    paymentIntents: { retrieve: jest.fn(async () => ({ latest_charge: null })) },
  },
}));

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

describe('kiloClawSubscriptionStarted template', () => {
  test('renders required fields', () => {
    const html = renderTemplate('kiloClawSubscriptionStarted', {
      plan_name: 'KiloClaw Standard',
      price_usd: '9.00',
      billing_period: 'Jan 1, 2026 – Feb 1, 2026',
      next_billing_date: 'February 1, 2026',
      manage_url: 'https://app.kilocode.ai/claw',
      year: '2026',
    });
    expect(html).toContain('KiloClaw Standard');
    expect(html).toContain('$9.00');
    expect(html).toContain('Jan 1, 2026 – Feb 1, 2026');
    expect(html).toContain('February 1, 2026');
    expect(html).toContain('https://app.kilocode.ai/claw');
  });
});

describe('subjects map', () => {
  test('includes the new templates', () => {
    const entries: TemplateName[] = ['creditsTopUp', 'kiloClawSubscriptionStarted'];
    for (const name of entries) {
      expect(subjects[name]).toBeTruthy();
    }
  });
});

describe('processTopUp credit top-up email', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  afterEach(() => {
    sendMock.mockClear();
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

    const topUpSends = sendMock.mock.calls
      .map(([params]) => params as { templateName: string; templateVars: Record<string, unknown> })
      .filter(p => p.templateName === 'creditsTopUp');
    expect(topUpSends).toHaveLength(1);
    expect(topUpSends[0].templateVars.amount_usd).toBe('15.00');

    sendMock.mockClear();

    // Retry / webhook replay with the same stripe_payment_id must not re-send.
    const second = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(second).toBe(false);

    const replayTopUpSends = sendMock.mock.calls
      .map(([params]) => params as { templateName: string })
      .filter(p => p.templateName === 'creditsTopUp');
    expect(replayTopUpSends).toHaveLength(0);
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

    const call = sendMock.mock.calls
      .map(([params]) => params as { templateName: string; subjectOverride?: string })
      .find(p => p.templateName === 'creditsTopUp');
    expect(call?.subjectOverride).toBe('Kilo auto top-up successful');
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

    const topUpSends = sendMock.mock.calls
      .map(([params]) => params as { templateName: string })
      .filter(p => p.templateName === 'creditsTopUp');
    expect(topUpSends).toHaveLength(0);

    // Sanity: the credit transaction was still recorded.
    const [txn] = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id))
      .limit(1);
    expect(txn).toBeTruthy();
  });
});

describe('KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE constant', () => {
  test('matches kiloclaw_email_log.email_type', () => {
    expect(KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE).toBe('kiloclaw_subscription_started');
  });

  test('kiloclaw_email_log unique index prevents duplicate inserts', async () => {
    const user = await insertTestUser({});

    // Use a synthetic instance_id; email log has no FK cascade requirement for the test
    // since we scope by user_id uniqueness. We need a real instance FK, so skip this test
    // if we cannot create an instance cheaply. Instead assert that the global unique index
    // (user_id, email_type) where instance_id IS NULL blocks duplicates.
    const first = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: null,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
      })
      .onConflictDoNothing();
    expect(first.rowCount).toBe(1);

    const second = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: null,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
      })
      .onConflictDoNothing();
    expect(second.rowCount).toBe(0);

    const rows = await db
      .select()
      .from(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, user.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    expect(rows).toHaveLength(1);
  });
});
