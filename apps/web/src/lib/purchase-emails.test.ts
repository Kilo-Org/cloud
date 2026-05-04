import { eq, and } from 'drizzle-orm';
import {
  credit_transactions,
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscription_change_log,
  kiloclaw_subscriptions,
  top_up_email_log,
} from '@kilocode/db/schema';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { processTopUp } from '@/lib/credits';
import {
  KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
  SUBSCRIPTION_STARTED_RECOVERY_WINDOW_MS,
} from '@/lib/kiloclaw/credit-billing';
import type * as creditBillingModule from '@/lib/kiloclaw/credit-billing';
import {
  renderTemplate,
  buildCreditsTopUpReceiptSection,
  subjects,
  sendCreditsTopUpEmail,
  sendKiloClawSubscriptionStartedEmail,
  type TemplateName,
} from '@/lib/email';

// Avoid firstTopupBonus side effects.
jest.mock('@/lib/firstTopupBonus', () => ({
  processFirstTopupBonus: jest.fn(),
}));

// Mock the outbound transport (Mailgun) and the upstream address-validity
// check (NeverBounce) rather than the helper exports. This way the real
// `send()`, `sendCreditsTopUpEmail`, and `sendKiloClawSubscriptionStartedEmail`
// wiring — formatUsd rounding, formatDate formatting, subjectOverride,
// credits_url / manage_url construction, receipt_section rendering — is
// exercised on every test, so a regression in any of that wiring fails here.
type SendViaMailgunParams = { to: string; subject: string; html: string; replyTo?: string };
const sendViaMailgunMock = jest.fn<Promise<boolean>, [SendViaMailgunParams]>(async () => true);
const verifyEmailMock = jest.fn<Promise<boolean>, [string]>(async () => true);

jest.mock('@/lib/email-mailgun', () => ({
  sendViaMailgun: (params: SendViaMailgunParams) => sendViaMailgunMock(params),
}));

jest.mock('@/lib/email-neverbounce', () => ({
  verifyEmail: (email: string) => verifyEmailMock(email),
}));

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

// Each template has a unique subject line (or a documented subjectOverride),
// so we discriminate Mailgun calls by subject rather than by templateName.
const CREDITS_TOPUP_MANUAL_SUBJECT = subjects.creditsTopUp;
const CREDITS_TOPUP_AUTO_SUBJECT = 'Kilo auto top-up successful';
const KILOCLAW_SUBSCRIPTION_STARTED_SUBJECT = subjects.kiloClawSubscriptionStarted;

function creditsTopUpSends(): SendViaMailgunParams[] {
  return sendViaMailgunMock.mock.calls
    .map(([params]) => params)
    .filter(
      p => p.subject === CREDITS_TOPUP_MANUAL_SUBJECT || p.subject === CREDITS_TOPUP_AUTO_SUBJECT
    );
}

function subscriptionStartedSends(): SendViaMailgunParams[] {
  return sendViaMailgunMock.mock.calls
    .map(([params]) => params)
    .filter(p => p.subject === KILOCLAW_SUBSCRIPTION_STARTED_SUBJECT);
}

describe('processTopUp credit top-up email', () => {
  beforeEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
  });

  afterEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
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

    const topUpSends = creditsTopUpSends();
    expect(topUpSends).toHaveLength(1);
    // $15.00 comes from formatUsd(1500) in the real helper — if formatUsd
    // rounding regresses, this assertion fails.
    expect(topUpSends[0].html).toContain('$15.00 USD');
    expect(topUpSends[0].to).toBe(user.google_user_email);

    sendViaMailgunMock.mockClear();

    // Retry / webhook replay with the same stripe_payment_id must not re-send.
    const second = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(second).toBe(false);

    expect(creditsTopUpSends()).toHaveLength(0);
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

    const autoSend = sendViaMailgunMock.mock.calls
      .map(([params]) => params)
      .find(p => p.subject === CREDITS_TOPUP_AUTO_SUBJECT);
    expect(autoSend).toBeTruthy();
    // The auto variant also swaps the heading/intro copy — prove both the
    // subject override and the templateVars wiring land.
    expect(autoSend?.html).toContain('Your auto top-up was successful');
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

    expect(creditsTopUpSends()).toHaveLength(0);

    // Sanity: the credit transaction was still recorded.
    const [txn] = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, user.id))
      .limit(1);
    expect(txn).toBeTruthy();
  });

  test('recovers confirmation email on webhook retry when first attempt did not send', async () => {
    // Simulate the failure mode: the first processTopUp committed the credit
    // transaction but exited before firing the email (no top_up_email_log
    // marker). A webhook retry must observe the missing marker and send.
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

    // Retry arrives. processTopUp sees the credit is already committed and
    // should attempt marker-gated email recovery.
    const retry = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(retry).toBe(false);

    expect(creditsTopUpSends()).toHaveLength(1);

    // Marker row exists to prevent a third attempt from re-sending.
    const [marker] = await db
      .select({ id: top_up_email_log.id })
      .from(top_up_email_log)
      .where(eq(top_up_email_log.stripe_payment_id, stripePaymentId))
      .limit(1);
    expect(marker).toBeTruthy();

    sendViaMailgunMock.mockClear();

    // A third retry must observe the marker and skip.
    const thirdAttempt = await processTopUp(user, 1500, {
      type: 'stripe',
      stripe_payment_id: stripePaymentId,
    });
    expect(thirdAttempt).toBe(false);
    expect(creditsTopUpSends()).toHaveLength(0);
  });

  test('writes a top_up_email_log marker on first-attempt send', async () => {
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
      .select({ stripe_payment_id: top_up_email_log.stripe_payment_id })
      .from(top_up_email_log)
      .where(eq(top_up_email_log.stripe_payment_id, stripePaymentId))
      .limit(1);
    expect(marker).toEqual({ stripe_payment_id: stripePaymentId });
  });

  test('recovery path skips email when skipPostTopUpFreeStuff is true on retry', async () => {
    // Guards against the edge case where a retry caller passes
    // skipPostTopUpFreeStuff: true (e.g. a Kilo Pass flow re-using
    // processTopUp as a primitive) — we must not send a user-facing top-up
    // confirmation email just because a marker was missing.
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

    expect(creditsTopUpSends()).toHaveLength(0);

    const [marker] = await db
      .select({ id: top_up_email_log.id })
      .from(top_up_email_log)
      .where(eq(top_up_email_log.stripe_payment_id, stripePaymentId))
      .limit(1);
    expect(marker).toBeUndefined();
  });
});

describe('KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE constant', () => {
  test('matches kiloclaw_email_log.email_type', () => {
    expect(KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE).toBe('kiloclaw_subscription_started');
  });

  test('kiloclaw_email_log unique index dedupes webhook replays of the same activation', async () => {
    // Production code writes (user_id, instance_id, email_type, period_start)
    // via the per-instance/period unique index. A second insert with the same
    // period_start collides (webhook replay).
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

    const second = await db
      .insert(kiloclaw_email_log)
      .values({
        user_id: user.id,
        instance_id: instance.id,
        email_type: KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE,
        period_start: periodStart,
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

  test('kiloclaw_email_log unique index allows a second row for a new activation period', async () => {
    // Cancel+resubscribe reuses the same kiloclaw_subscriptions row but
    // stamps a fresh current_period_start, so the per-activation unique
    // index admits a second row and a second email goes out.
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
      .select()
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

// ── Stripe-funded settlement → subscription-started email ──────────────────

describe('applyStripeFundedKiloClawPeriod subscription-started email', () => {
  beforeEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
  });
  afterEach(() => {
    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();
  });

  async function applyStripeFundedKiloClawPeriod(
    params: Parameters<typeof creditBillingModule.applyStripeFundedKiloClawPeriod>[0]
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
    return subscriptionStartedSends().length;
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

  test('$0 Stripe settlement (full coupon / promo) still sends one subscription-started email', async () => {
    // Per KiloClaw billing spec Stripe-Funded Credit Settlement rule 10,
    // `$0` KiloClaw invoices must still run settlement so Stripe-created
    // subscriptions transition into the activated hybrid state. The
    // subscription-started email is an activation notification, not a
    // revenue side effect, so it must fire even when amount_paid is 0.
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

    const zeroAmountSend = subscriptionStartedSends()[0];
    expect(zeroAmountSend).toBeTruthy();
    // formatUsd(0) must render "0.00", not "0" or "NaN" — real helper wiring.
    expect(zeroAmountSend.html).toContain('$0.00 USD');
  });

  test('activate → cancel → resubscribe on same instance sends a second subscription-started email', async () => {
    // Real-world flow: user activates, receives the email, cancels, then
    // resubscribes later. Both paid activations on the same instance should
    // each send a subscription-started email because each activation covers
    // a different period. The per-instance lifetime dedupe (pre-fix) would
    // suppress the second email.
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_resubscribe_${crypto.randomUUID()}`;
    const { instance, subscription } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    // First activation: trial → paid.
    const firstPeriodStart = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const firstPeriodEnd = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_first_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: firstPeriodStart,
      periodEnd: firstPeriodEnd,
    });
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(1);

    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();

    // Simulate cancellation: status=canceled on the same row.
    await db
      .update(kiloclaw_subscriptions)
      .set({ status: 'canceled' })
      .where(eq(kiloclaw_subscriptions.id, subscription.id));

    // Second activation (resubscribe): same row, fresh period boundaries.
    const secondPeriodStart = new Date().toISOString();
    const secondPeriodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const applied = await applyStripeFundedKiloClawPeriod({
      userId: user.id,
      metadataInstanceId: instance.id,
      stripeSubscriptionId,
      stripePaymentId: `ch_second_${crypto.randomUUID()}`,
      plan: 'standard',
      amountMicrodollars: 9_000_000,
      periodStart: secondPeriodStart,
      periodEnd: secondPeriodEnd,
    });

    expect(applied).toBe(true);
    expect(countSubscriptionStartedSends()).toBe(1);
    expect(await countEmailLogRows(user.id, instance.id)).toBe(2);
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

  // past_due and unpaid are Stripe's dunning states — the subscription is
  // already activated on a paid plan and Stripe is retrying a failed renewal
  // charge. When that retry eventually succeeds, the settlement reaches this
  // code path with `before.status` still set to the dunning value. Per
  // shouldSendSubscriptionStartedEmailForActivation these MUST NOT send the
  // subscription-started email — it would be a duplicate activation
  // notification for a plan the user was already on.
  test('past_due recovery settlement → no subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_past_due_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'past_due',
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

  test('unpaid recovery settlement → no subscription-started email', async () => {
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_unpaid_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'unpaid',
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

    sendViaMailgunMock.mockClear();
    verifyEmailMock.mockClear();

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

  test('provider_not_configured → email log row is cleared so a retry can re-attempt', async () => {
    // Regression: maybeSendKiloClawSubscriptionStartedEmail used to insert the
    // kiloclaw_email_log marker before calling the provider, and only delete
    // it if the send threw. When the provider returned {sent: false,
    // reason: 'provider_not_configured'} without throwing, the marker
    // remained and permanently suppressed the email on future retries.
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_provider_unconfigured_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    // Mailgun returns false when MAILGUN_API_KEY/MAILGUN_DOMAIN are missing,
    // which `send()` translates into { sent: false, reason: 'provider_not_configured' }.
    sendViaMailgunMock.mockImplementationOnce(async () => false);

    const periodStart = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();

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
    // We did attempt to send exactly once, but the provider wasn't configured.
    expect(countSubscriptionStartedSends()).toBe(1);
    // The marker row must be gone so a later retry can re-attempt — the
    // unique index would otherwise permanently suppress this activation.
    expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
  });

  test('neverbounce_rejected → email log row is retained so we do not retry a terminally invalid address', async () => {
    // NeverBounce's "invalid" / "disposable" verdict is terminal for that
    // address; retrying would loop forever. Leaving the kiloclaw_email_log
    // row in place makes the outcome idempotent: we tried once, the address
    // was rejected, we don't try again.
    const user = await insertTestUser({});
    const stripeSubscriptionId = `sub_neverbounce_rejected_${crypto.randomUUID()}`;
    const { instance } = await seedSubscription({
      userId: user.id,
      status: 'trialing',
      plan: 'trial',
      stripeSubscriptionId,
    });

    // NeverBounce returns false for invalid/disposable addresses, which
    // `send()` translates into { sent: false, reason: 'neverbounce_rejected' }.
    verifyEmailMock.mockImplementationOnce(async () => false);

    const periodStart = new Date().toISOString();
    const periodEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();

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
    // verifyEmail was called once for this user (the send attempt),
    // so we did try. sendViaMailgun was not reached because verification
    // rejected the address — which is the whole point of this branch.
    expect(verifyEmailMock).toHaveBeenCalledWith(user.google_user_email);
    expect(countSubscriptionStartedSends()).toBe(0);
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
    expect(await countEmailLogRows(user.id, instance.id)).toBe(0);
  });
});

// ── Direct helper payload tests ────────────────────────────────────────────
// The surrounding describe blocks mock @/lib/email-mailgun and exercise the
// real helpers through production call sites. These tests assert the exact
// Mailgun payload the helpers emit, protecting:
//   - formatUsd rounding
//   - formatDate formatting
//   - purchase_date / credits_url / receipt_section / manage_url mapping
//   - subjectOverride selection

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
    // formatUsd(1500) rounding.
    expect(params.html).toContain('$15.00 USD');
    // formatDate en-US UTC formatting.
    expect(params.html).toContain('January 15, 2026');
    // credits_url construction (NEXTAUTH_URL + '/credits' — http://localhost:3000 in tests).
    expect(params.html).toContain('/credits');
    // receipt_section rendering (RawHtml, escaped href).
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
    // No receipt URL → receipt section empty, "View your Stripe receipt" absent.
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

  test('emits the canonical subject, formatted price/next-billing-date, and the manage link', async () => {
    const result = await sendKiloClawSubscriptionStartedEmail({
      to: 'recipient@example.com',
      planName: 'KiloClaw Standard',
      priceCents: 900,
      billingPeriod: 'Jan 15, 2026 – Feb 15, 2026',
      nextBillingDate: new Date('2026-02-15T00:00:00Z'),
    });

    expect(result).toEqual({ sent: true });
    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.to).toBe('recipient@example.com');
    expect(params.subject).toBe(subjects.kiloClawSubscriptionStarted);
    expect(params.html).toContain('KiloClaw Standard');
    // formatUsd(900).
    expect(params.html).toContain('$9.00 USD');
    expect(params.html).toContain('Jan 15, 2026 – Feb 15, 2026');
    // formatDate(next billing).
    expect(params.html).toContain('February 15, 2026');
    // manage_url construction (NEXTAUTH_URL + '/claw').
    expect(params.html).toContain('/claw');
  });

  test('zero-cent price still renders "$0.00 USD" (formatUsd rounding)', async () => {
    await sendKiloClawSubscriptionStartedEmail({
      to: 'recipient@example.com',
      planName: 'KiloClaw Standard',
      priceCents: 0,
      billingPeriod: 'Jan 1, 2026 – Feb 1, 2026',
      nextBillingDate: new Date('2026-02-01T00:00:00Z'),
    });

    const [params] = sendViaMailgunMock.mock.calls[0];
    expect(params.html).toContain('$0.00 USD');
  });
});
