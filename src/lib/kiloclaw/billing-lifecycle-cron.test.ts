process.env.KILOCLAW_BILLING_ENFORCEMENT = 'true';
process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID ||= 'price_standard_intro';

import { describe, expect, it, beforeEach, jest } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { kiloclaw_subscriptions, kiloclaw_instances } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { sandboxIdFromUserId } from '@/lib/kiloclaw/sandbox-id';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import type { runKiloClawBillingLifecycleCron as RunCronFn } from './billing-lifecycle-cron';

jest.mock('@/lib/stripe-client', () => {
  const stripeMock = {
    subscriptions: { retrieve: jest.fn(), update: jest.fn(), list: jest.fn() },
    subscriptionSchedules: {
      create: jest.fn(),
      update: jest.fn(),
      release: jest.fn(),
      retrieve: jest.fn(),
    },
    checkout: { sessions: { create: jest.fn(), list: jest.fn(), expire: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
  };
  return { client: stripeMock };
});

jest.mock('@/lib/email', () => ({
  send: jest.fn<() => Promise<{ sent: true }>>().mockResolvedValue({ sent: true }),
}));

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => {
  const mockFn = () => jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  return {
    KiloClawInternalClient: jest.fn<() => unknown>().mockImplementation(() => ({
      start: mockFn(),
      stop: mockFn(),
      provision: mockFn(),
      destroy: mockFn(),
      getStatus: mockFn(),
    })),
    KiloClawApiError: class KiloClawApiError extends Error {
      statusCode: number;
      responseBody: string;
      constructor(statusCode: number, responseBody: string) {
        super(`KiloClawApiError: ${statusCode}`);
        this.statusCode = statusCode;
        this.responseBody = responseBody;
      }
    },
  };
});

jest.mock('@/lib/kiloclaw/stripe-handlers', () => ({
  autoResumeIfSuspended: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  ensureAutoIntroSchedule: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock('@/lib/kiloclaw/credit-billing', () => ({
  KILOCLAW_PLAN_COST_MICRODOLLARS: { standard: 9_000_000, commit: 48_000_000 },
  projectPendingKiloPassBonusMicrodollars: jest.fn<() => number>().mockReturnValue(0),
}));

jest.mock('@/lib/kilo-pass/usage-triggered-bonus', () => ({
  maybeIssueKiloPassBonusFromUsageThreshold: jest
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined),
}));

jest.mock('@/lib/autoTopUp', () => ({
  maybePerformAutoTopUp: jest
    .fn<() => Promise<{ success: boolean }>>()
    .mockResolvedValue({ success: false }),
}));

jest.mock('@/lib/kiloclaw/stripe-price-ids.server', () => ({
  isIntroPriceId: jest.fn<() => boolean>(() => false),
}));

// ── Test setup ──────────────────────────────────────────────────────────────

let runKiloClawBillingLifecycleCron: typeof RunCronFn;

let user: User;

beforeEach(async () => {
  await cleanupDbForTest();
  user = await insertTestUser({
    google_user_email: `cron-test-${Math.random()}@example.com`,
  });

  // Dynamic import after mocks are in place
  const mod = await import('./billing-lifecycle-cron');
  runKiloClawBillingLifecycleCron = mod.runKiloClawBillingLifecycleCron;
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function createInstance(userId: string) {
  const [instance] = await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: sandboxIdFromUserId(userId),
    })
    .returning();
  return instance;
}

// ── Sweep 1: Trial Expiry targets by subscription id ────────────────────────

describe('Sweep 1: Trial Expiry targeting', () => {
  it('cancels only the expired trialing subscription, not a separate active subscription', async () => {
    const instance = await createInstance(user.id);

    // Insert an expired trialing subscription (no instance_id so it doesn't
    // conflict with the unique partial index on instance_id).
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: null,
      plan: 'trial',
      status: 'trialing',
      trial_started_at: new Date(Date.now() - 14 * 86_400_000).toISOString(),
      trial_ends_at: new Date(Date.now() - 1 * 86_400_000).toISOString(), // expired yesterday
    });

    // Insert a separate active paid subscription with the instance
    await db.insert(kiloclaw_subscriptions).values({
      user_id: user.id,
      instance_id: instance.id,
      plan: 'standard',
      status: 'active',
      payment_source: 'credits',
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      credit_renewal_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    });

    const summary = await runKiloClawBillingLifecycleCron(db);
    expect(summary.sweep1_trial_expiry).toBe(1);

    // Fetch all subscriptions for this user
    const subs = await db
      .select()
      .from(kiloclaw_subscriptions)
      .where(eq(kiloclaw_subscriptions.user_id, user.id));

    const trialSub = subs.find(s => s.plan === 'trial');
    const activeSub = subs.find(s => s.plan === 'standard');

    // The expired trial should have been canceled
    expect(trialSub).toBeDefined();
    expect(trialSub!.status).toBe('canceled');
    expect(trialSub!.suspended_at).not.toBeNull();

    // The active paid subscription must NOT be touched
    expect(activeSub).toBeDefined();
    expect(activeSub!.status).toBe('active');
    expect(activeSub!.suspended_at).toBeNull();
  });
});
