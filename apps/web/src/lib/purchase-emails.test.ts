import { eq, and } from 'drizzle-orm';
import {
  credit_transactions,
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { processTopUp } from '@/lib/credits';
import {
  KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
  SUBSCRIPTION_STARTED_RECOVERY_WINDOW_MS,
} from '@/lib/kiloclaw/credit-billing';
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

// Count email sends via the shared `send` export as well as the
// `sendKiloClawSubscriptionStartedEmail` / `sendCreditsTopUpEmail` helpers.
// The helpers are replaced with jest.fns that forward the call via
// sendMock using a synthetic `templateName` so existing tests that filter
// by templateName continue to work.
const sendMock = jest.fn(async (_params: unknown) => ({ sent: true as const }));

jest.mock('@/lib/email', () => {
  const actual = jest.requireActual<typeof emailModule>('@/lib/email');
  return {
    ...actual,
    send: jest.fn((params: unknown) => sendMock(params)),
    sendCreditsTopUpEmail: jest.fn(
      async (props: {
        to: string;
        variant: 'auto' | 'manual';
        amountCents: number;
        creditsCents: number;
        purchaseDate: Date;
        receiptUrl: string | null;
      }) =>
        sendMock({
          to: props.to,
          templateName: 'creditsTopUp',
          templateVars: {
            amount_usd: (props.amountCents / 100).toFixed(2),
            credits_usd: (props.creditsCents / 100).toFixed(2),
            receipt_url: props.receiptUrl,
            variant: props.variant,
          },
          subjectOverride: props.variant === 'auto' ? 'Kilo auto top-up successful' : undefined,
        })
    ),
    sendKiloClawSubscriptionStartedEmail: jest.fn(
      async (props: {
        to: string;
        planName: string;
        priceCents: number;
        billingPeriod: string;
        nextBillingDate: Date;
      }) =>
        sendMock({
          to: props.to,
          templateName: 'kiloClawSubscriptionStarted',
          templateVars: {
            plan_name: props.planName,
            price_usd: (props.priceCents / 100).toFixed(2),
            billing_period: props.billingPeriod,
            next_billing_date: props.nextBillingDate.toISOString(),
          },
        })
    ),
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

// Settlement post-commit side effects that aren't relevant to email behavior.
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

  test('kiloclaw_email_log unique index prevents duplicate inserts for (user, instance, type)', async () => {
    // Production code writes (user_id, instance_id, email_type) via the
    // per-instance unique index, so test that exact shape here.
    const user = await insertTestUser({});
    const [instance] = await db
      .insert(kiloclaw_instances)
      .values({
        user_id: user.id,
        sandbox_id: `test-sandbox-${crypto.randomUUID()}`,
      })
      .returning();

    const first = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
      })
      .onConflictDoNothing();
    expect(first.rowCount).toBe(1);

    const second = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
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
          eq(kiloclaw_email_log.instance_id, instance.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    expect(rows).toHaveLength(1);
  });
});

// ── Stripe-funded settlement → subscription-started email ──────────────────

describe('applyStripeFundedKiloClawPeriod subscription-started email', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });
  afterEach(() => {
    sendMock.mockClear();
  });

  async function applyStripeFundedKiloClawPeriod(
    params: Parameters<
      typeof import('@/lib/kiloclaw/credit-billing').applyStripeFundedKiloClawPeriod
    >[0]
  ): Promise<boolean> {
    const mod = await import('@/lib/kiloclaw/credit-billing');
    return mod.applyStripeFundedKiloClawPeriod(params);
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
    return sendMock.mock.calls.filter(
      ([params]) =>
        (params as { templateName: string }).templateName === 'kiloClawSubscriptionStarted'
    ).length;
  }

  async function countEmailLogRows(userId: string, instanceId: string): Promise<number> {
    const rows = await db
      .select()
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

  test('trialing trial → Stripe settlement sends one subscription-started email and writes the log row', async () => {
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

  test('canceled trial → Stripe settlement sends one subscription-started email', async () => {
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

  test('canceled paid row → Stripe settlement sends one subscription-started email for resubscribe', async () => {
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

  test('subscription.created before invoice.paid → settlement still sends one subscription-started email', async () => {
    // Realistic Stripe ordering: customer.subscription.created is processed
    // before invoice.paid. handleKiloClawSubscriptionCreated flips a non-hybrid
    // row to status='active', stamps the Stripe-derived period boundaries onto
    // the row, and writes a durable `stripe_subscription_created` change-log
    // row preserving the pre-Stripe status. The subsequent settlement's
    // in-memory `before.status` is already 'active', so the email decision
    // must fall back to the durable log.
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

    const trialingSnapshot = subscription;
    // Simulate handleKiloClawSubscriptionCreated running before invoice.paid
    // (see apps/web/src/lib/kiloclaw/stripe-handlers.ts): for non-hybrid rows
    // it stamps the Stripe-derived plan, status, and period boundaries.
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
      before: trialingSnapshot,
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

  test('active renewal → no subscription-started email', async () => {
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

  test('active renewal after a prior activation → eligible subscription.created log for a different period does NOT trigger a second email', async () => {
    // Defence-in-depth for the durable-signal fallback: the helper matches on
    // plan + period boundaries of the `stripe_subscription_created.after_state`
    // against the current settlement period, so an activation log recorded for
    // the original (earlier) period cannot re-fire the email on subsequent
    // renewal settlements that cover a different period.
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_renewal_after_prior_${crypto.randomUUID()}`;
    const { instance, subscription } = await seedSubscription({
      userId: user.id,
      status: 'active',
      plan: 'standard',
      stripeSubscriptionId,
    });

    // Original stripe_subscription_created (trialing → active) from activation.
    // `subscription.current_period_start/end` are seeded to the prior period
    // (30 days ago → 1 day ago), which is deliberately different from the
    // renewal settlement period used below.
    await insertKiloClawSubscriptionChangeLog(db, {
      subscriptionId: subscription.id,
      actor: { actorType: 'system', actorId: 'stripe-webhook' },
      action: 'status_changed',
      reason: 'stripe_subscription_created',
      before: { ...subscription, status: 'trialing' },
      after: subscription,
    });
    // Prior settlement that already handled the activation email.
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

  test('duplicate webhook replay → no second email when the log row already exists', async () => {
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

    sendMock.mockClear();

    // Same stripe_payment_id → processTopUp returns false (duplicate credit),
    // so we take the duplicate-recovery path. The kiloclaw_email_log row from
    // the first run must block a second send.
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

  test('duplicate webhook recovery → replay sends email once when durable change log shows paid activation but email log is missing', async () => {
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

    // Simulate the first run failing to send the email (marker not persisted):
    // delete the email-log row, then replay with same stripe_payment_id.
    await db
      .delete(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, user.id),
          eq(kiloclaw_email_log.instance_id, instance.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    sendMock.mockClear();

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

  test('stale duplicate recovery guard → old change-log row outside the window does not trigger a recovered email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_stale_${crypto.randomUUID()}`;
    const { instance, subscription } = await seedSubscription({
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

    // Backdate the change-log row well outside the recovery window relative
    // to periodStart, and clear the email-log row. A replay must NOT send.
    const backdated = new Date(
      new Date(periodStart).getTime() - SUBSCRIPTION_STARTED_RECOVERY_WINDOW_MS - 86_400_000
    ).toISOString();
    await db
      .update(kiloclaw_subscription_change_log)
      .set({ created_at: backdated })
      .where(
        and(
          eq(kiloclaw_subscription_change_log.subscription_id, subscription.id),
          eq(kiloclaw_subscription_change_log.action, 'period_advanced'),
          eq(kiloclaw_subscription_change_log.reason, 'stripe_invoice_settlement')
        )
      );
    await db
      .delete(kiloclaw_email_log)
      .where(
        and(
          eq(kiloclaw_email_log.user_id, user.id),
          eq(kiloclaw_email_log.instance_id, instance.id),
          eq(kiloclaw_email_log.email_type, KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE)
        )
      );
    sendMock.mockClear();

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
    expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
  });
});
