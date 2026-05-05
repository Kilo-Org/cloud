process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

import { eq, and } from 'drizzle-orm';
import {
  kiloclaw_email_log,
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { insertKiloClawSubscriptionChangeLog } from '@kilocode/db';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { KILOCLAW_SUBSCRIPTION_STARTED_EMAIL_TYPE } from '@/lib/kiloclaw/credit-billing';
import type * as creditBillingModule from '@/lib/kiloclaw/credit-billing';
import {
  renderTemplate,
  subjects,
  sendKiloClawSubscriptionStartedEmail,
  type TemplateName,
} from '@/lib/email';

// Avoid firstTopupBonus side effects.
jest.mock('@/lib/firstTopupBonus', () => ({
  processFirstTopupBonus: jest.fn(),
}));

// Mock the outbound transport (Mailgun) and the upstream address-validity
// check (NeverBounce) rather than the helper exports. This way the real
// `send()` and `sendKiloClawSubscriptionStartedEmail`
// wiring — formatUsd rounding, formatDate formatting, subjectOverride,
// and manage_url construction — is exercised on every test, so a regression
// in any of that wiring fails here.
type SendViaMailgunParams = { to: string; subject: string; html: string; replyTo?: string };
const sendViaMailgunMock = jest.fn<Promise<boolean>, [SendViaMailgunParams]>(async () => true);
const verifyEmailMock = jest.fn<Promise<boolean>, [string]>(async () => true);

jest.mock('@/lib/email-mailgun', () => ({
  sendViaMailgun: (params: SendViaMailgunParams) => sendViaMailgunMock(params),
}));

jest.mock('@/lib/email-neverbounce', () => ({
  verifyEmail: (email: string) => verifyEmailMock(email),
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

describe('kiloClawSubscriptionStarted template', () => {
  test('renders required fields', () => {
    const html = renderTemplate('kiloClawSubscriptionStarted', {
      plan_name: 'KiloClaw Standard',
      price_usd: '9.00',
      billing_period: 'Jan 1, 2026 – Feb 1, 2026',
      next_billing_date: 'February 1, 2026',
      manage_url: 'https://app.kilocode.ai/claw/subscription',
      year: '2026',
    });
    expect(html).toContain('KiloClaw Standard');
    expect(html).toContain('$9.00');
    expect(html).toContain('Jan 1, 2026 – Feb 1, 2026');
    expect(html).toContain('February 1, 2026');
    expect(html).toContain('https://app.kilocode.ai/claw/subscription');
  });
});

describe('subjects map', () => {
  test('includes the new templates', () => {
    const entries: TemplateName[] = ['kiloClawSubscriptionStarted'];
    for (const name of entries) {
      expect(subjects[name]).toBeTruthy();
    }
  });
});

// Each template has a unique subject line (or a documented subjectOverride),
// so we discriminate Mailgun calls by subject rather than by templateName.
const KILOCLAW_SUBSCRIPTION_STARTED_SUBJECT = subjects.kiloClawSubscriptionStarted;

function subscriptionStartedSends(): SendViaMailgunParams[] {
  return sendViaMailgunMock.mock.calls
    .map(([params]) => params)
    .filter(p => p.subject === KILOCLAW_SUBSCRIPTION_STARTED_SUBJECT);
}

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

  test('trialing trial → credit enrollment sends one subscription-started email and writes the log row', async () => {
    const user = await insertTestUser({ total_microdollars_acquired: 50_000_000 });
    const instance = await seedCreditEnrollmentAnchor(user.id);

    const mod = await import('@/lib/kiloclaw/credit-billing');
    await mod.enrollWithCredits({
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
});

// ── Direct helper payload tests ────────────────────────────────────────────
// The surrounding describe blocks mock @/lib/email-mailgun and exercise the
// real helpers through production call sites. These tests assert the exact
// Mailgun payload the helpers emit, protecting:
//   - formatUsd rounding
//   - formatDate formatting
//   - manage_url mapping
//   - subjectOverride selection

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
    // manage_url construction (NEXTAUTH_URL + '/claw/subscription').
    expect(params.html).toContain('/claw/subscription');
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
