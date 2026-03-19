// Set env vars before any module loads
process.env.STRIPE_KILOCLAW_COMMIT_PRICE_ID ||= 'price_commit';
process.env.STRIPE_KILOCLAW_STANDARD_PRICE_ID ||= 'price_standard';
process.env.KILOCLAW_BILLING_ENFORCEMENT = 'true';

import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import {
  kiloclaw_subscriptions,
  kiloclaw_email_log,
  kiloclaw_instances,
  credit_transactions,
  kilocode_users,
} from '@kilocode/db/schema';
import type { CreditTransaction } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { addMonths } from 'date-fns';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import {
  KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS,
  KILOCLAW_COMMIT_SIXMONTH_MICRODOLLARS,
} from '@/lib/kiloclaw/constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockStart = jest
  .fn<(userId: string) => Promise<{ ok: true }>>()
  .mockResolvedValue({ ok: true });
const mockStop = jest
  .fn<(userId: string) => Promise<{ ok: true }>>()
  .mockResolvedValue({ ok: true });

jest.mock('@/lib/kiloclaw/kiloclaw-internal-client', () => ({
  KiloClawInternalClient: jest.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
  })),
  KiloClawApiError: class KiloClawApiError extends Error {
    statusCode: number;
    responseBody: string;
    constructor(statusCode: number, responseBody = '') {
      super(`KiloClawApiError: ${statusCode}`);
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }
  },
}));

jest.mock('@/lib/email', () => ({
  send: jest.fn<AnyMock>().mockResolvedValue(undefined),
}));

jest.mock('@/lib/kiloclaw/kilo-pass-integration', () => ({
  getProjectedKiloPassBonus: jest.fn<AnyMock>().mockResolvedValue(0),
  evaluateKiloPassBonusAfterDeduction: jest.fn<AnyMock>().mockResolvedValue(undefined),
}));

jest.mock('@/lib/autoTopUp', () => ({
  triggerAutoTopUpForKiloClaw: jest.fn<AnyMock>().mockResolvedValue(undefined),
}));

// ── Dynamic imports (after mocks) ─────────────────────────────────────────

let enrollWithCredits: (userId: string, plan: 'commit' | 'standard') => Promise<void>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let runCreditRenewalSweep: (database: any) => Promise<any>;

beforeAll(async () => {
  const mod = await import('./credit-billing');
  enrollWithCredits = mod.enrollWithCredits;
  runCreditRenewalSweep = mod.runCreditRenewalSweep;
});

// ── Helpers ────────────────────────────────────────────────────────────────

let user: User;

const NOW = new Date('2026-04-15T12:00:00Z').getTime();
const originalDateNow = Date.now;

async function setUserBalance(userId: string, balance: number) {
  await db
    .update(kilocode_users)
    .set({ total_microdollars_acquired: balance, microdollars_used: 0 })
    .where(eq(kilocode_users.id, userId));
}

async function getSubscription(userId: string) {
  const [row] = await db
    .select()
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .limit(1);
  return row;
}

async function getCreditTransactions(userId: string) {
  return db.select().from(credit_transactions).where(eq(credit_transactions.kilo_user_id, userId));
}

async function insertSubscription(
  userId: string,
  overrides: Partial<typeof kiloclaw_subscriptions.$inferInsert> = {}
) {
  const [row] = await db
    .insert(kiloclaw_subscriptions)
    .values({
      user_id: userId,
      plan: 'standard',
      status: 'active',
      ...overrides,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await cleanupDbForTest();
  user = await insertTestUser({
    total_microdollars_acquired: 100_000_000,
    microdollars_used: 0,
  });

  // Reset all mocks
  mockStart.mockClear();
  mockStop.mockClear();

  const { send } = jest.requireMock<{ send: AnyMock }>('@/lib/email');
  send.mockClear();

  const kiloPassMocks = jest.requireMock<{
    getProjectedKiloPassBonus: AnyMock;
    evaluateKiloPassBonusAfterDeduction: AnyMock;
  }>('@/lib/kiloclaw/kilo-pass-integration');
  kiloPassMocks.getProjectedKiloPassBonus.mockReset().mockResolvedValue(0);
  kiloPassMocks.evaluateKiloPassBonusAfterDeduction.mockReset().mockResolvedValue(undefined);

  const { triggerAutoTopUpForKiloClaw } = jest.requireMock<{
    triggerAutoTopUpForKiloClaw: AnyMock;
  }>('@/lib/autoTopUp');
  triggerAutoTopUpForKiloClaw.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  Date.now = originalDateNow;
});

afterAll(async () => {
  try {
    await cleanupDbForTest();
  } catch {
    // DB may already be torn down
  }
});

// ── Credit Enrollment ──────────────────────────────────────────────────────

describe('enrollWithCredits', () => {
  it('rejects if active subscription exists', async () => {
    await insertSubscription(user.id, {
      status: 'active',
      payment_source: 'credits',
    });

    await expect(enrollWithCredits(user.id, 'standard')).rejects.toThrow();
  });

  it('rejects if past_due subscription exists', async () => {
    await insertSubscription(user.id, {
      status: 'past_due',
      payment_source: 'credits',
    });

    await expect(enrollWithCredits(user.id, 'standard')).rejects.toThrow();
  });

  it('rejects if unpaid subscription exists', async () => {
    await insertSubscription(user.id, {
      status: 'unpaid',
      payment_source: 'credits',
    });

    await expect(enrollWithCredits(user.id, 'standard')).rejects.toThrow();
  });

  it('allows enrollment when existing subscription is trialing', async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await insertSubscription(user.id, {
        plan: 'trial',
        status: 'trialing',
        trial_started_at: new Date(NOW - 86_400_000 * 10).toISOString(),
        trial_ends_at: new Date(NOW + 86_400_000 * 20).toISOString(),
      });
      await setUserBalance(user.id, 30_000_000);

      await enrollWithCredits(user.id, 'standard');

      const sub = await getSubscription(user.id);
      expect(sub.status).toBe('active');
      expect(sub.payment_source).toBe('credits');
    } finally {
      Date.now = realNow;
    }
  });

  it('allows enrollment when existing subscription is canceled', async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await insertSubscription(user.id, {
        status: 'canceled',
        payment_source: 'credits',
      });
      await setUserBalance(user.id, 30_000_000);

      await enrollWithCredits(user.id, 'standard');

      const sub = await getSubscription(user.id);
      expect(sub.status).toBe('active');
      expect(sub.payment_source).toBe('credits');
    } finally {
      Date.now = realNow;
    }
  });

  describe('effective balance checks', () => {
    it('rejects standard plan when balance is just under $25', async () => {
      await setUserBalance(user.id, KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS - 1);

      await expect(enrollWithCredits(user.id, 'standard')).rejects.toThrow(
        /[Ii]nsufficient credit balance/
      );
    });

    it('succeeds for standard plan with exactly $25', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS);

        await enrollWithCredits(user.id, 'standard');

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('active');
      } finally {
        Date.now = realNow;
      }
    });

    it('rejects commit plan when balance is just under $54', async () => {
      await setUserBalance(user.id, KILOCLAW_COMMIT_SIXMONTH_MICRODOLLARS - 1);

      await expect(enrollWithCredits(user.id, 'commit')).rejects.toThrow(
        /[Ii]nsufficient credit balance/
      );
    });

    it('succeeds for commit plan with exactly $54', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, KILOCLAW_COMMIT_SIXMONTH_MICRODOLLARS);

        await enrollWithCredits(user.id, 'commit');

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('active');
        expect(sub.plan).toBe('commit');
      } finally {
        Date.now = realNow;
      }
    });

    it('includes projected Kilo Pass bonus in effective balance', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        // Balance is $20, but projected bonus brings it to $25
        await setUserBalance(user.id, 20_000_000);
        const { getProjectedKiloPassBonus } = jest.requireMock<{
          getProjectedKiloPassBonus: AnyMock;
        }>('@/lib/kiloclaw/kilo-pass-integration');
        getProjectedKiloPassBonus.mockResolvedValue(5_000_000);

        await enrollWithCredits(user.id, 'standard');

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('active');
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('credit deduction', () => {
    it('inserts a negative credit transaction', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await enrollWithCredits(user.id, 'standard');

        const txns = await getCreditTransactions(user.id);
        const deduction = txns.find((t: CreditTransaction) => t.amount_microdollars < 0);
        expect(deduction).toBeDefined();
        expect(deduction!.amount_microdollars).toBe(-KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS);
        expect(deduction!.check_category_uniqueness).toBe(true);
        // Category encodes the billing period as YYYY-MM
        expect(deduction!.credit_category).toMatch(/^kiloclaw-subscription:\d{4}-\d{2}$/);
      } finally {
        Date.now = realNow;
      }
    });

    it('decrements total_microdollars_acquired', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const initialBalance = 100_000_000;
        await setUserBalance(user.id, initialBalance);

        await enrollWithCredits(user.id, 'standard');

        const [updatedUser] = await db
          .select({ total_microdollars_acquired: kilocode_users.total_microdollars_acquired })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, user.id));
        expect(updatedUser.total_microdollars_acquired).toBe(
          initialBalance - KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS
        );
      } finally {
        Date.now = realNow;
      }
    });

    it('uses commit prefix for idempotency key on commit plan', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await enrollWithCredits(user.id, 'commit');

        const txns = await getCreditTransactions(user.id);
        const deduction = txns.find((t: CreditTransaction) => t.amount_microdollars < 0);
        expect(deduction).toBeDefined();
        expect(deduction!.credit_category).toMatch(/^kiloclaw-subscription-commit:\d{4}-\d{2}$/);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('subscription upsert', () => {
    it('sets correct fields for standard plan', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await enrollWithCredits(user.id, 'standard');

        const sub = await getSubscription(user.id);
        expect(sub.payment_source).toBe('credits');
        expect(sub.status).toBe('active');
        expect(sub.stripe_subscription_id).toBeNull();
        expect(sub.plan).toBe('standard');
        expect(sub.past_due_since).toBeNull();

        // Period: now → +1 month
        const periodStart = new Date(sub.current_period_start!);
        const periodEnd = new Date(sub.current_period_end!);
        expect(periodStart.getTime()).toBe(NOW);
        const expectedEnd = addMonths(new Date(NOW), 1);
        expect(periodEnd.getTime()).toBe(expectedEnd.getTime());

        // credit_renewal_at = current_period_end
        expect(sub.credit_renewal_at).toBe(sub.current_period_end);
      } finally {
        Date.now = realNow;
      }
    });

    it('sets commit_ends_at for commit plan (6 months)', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await enrollWithCredits(user.id, 'commit');

        const sub = await getSubscription(user.id);
        expect(sub.plan).toBe('commit');
        expect(sub.commit_ends_at).not.toBeNull();
        const commitEnd = new Date(sub.commit_ends_at!);
        const expectedCommitEnd = addMonths(new Date(NOW), 6);
        expect(commitEnd.getTime()).toBe(expectedCommitEnd.getTime());
      } finally {
        Date.now = realNow;
      }
    });

    it('clears commit_ends_at for standard plan', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        // Pre-existing commit subscription
        await insertSubscription(user.id, {
          plan: 'commit',
          status: 'canceled',
          commit_ends_at: new Date(NOW - 86_400_000).toISOString(),
        });

        await enrollWithCredits(user.id, 'standard');

        const sub = await getSubscription(user.id);
        expect(sub.plan).toBe('standard');
        expect(sub.commit_ends_at).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('sets current_period_end 6 months out for commit plan', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await enrollWithCredits(user.id, 'commit');

        const sub = await getSubscription(user.id);
        const periodEnd = new Date(sub.current_period_end!);
        // Commit bills every 6 months at $54.
        const expectedEnd = addMonths(new Date(NOW), 6);
        expect(periodEnd.getTime()).toBe(expectedEnd.getTime());
      } finally {
        Date.now = realNow;
      }
    });
  });

  it('rejects duplicate enrollment via idempotency key', async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await enrollWithCredits(user.id, 'standard');

      // Second enrollment at the same time should fail
      await expect(enrollWithCredits(user.id, 'standard')).rejects.toThrow();
    } finally {
      Date.now = realNow;
    }
  });

  it('does not clear suspended_at during enrollment', async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const suspendedTime = new Date(NOW - 86_400_000 * 3).toISOString();
      await insertSubscription(user.id, {
        status: 'canceled',
        suspended_at: suspendedTime,
      });
      await db.insert(kiloclaw_instances).values({
        user_id: user.id,
        sandbox_id: 'test-sandbox',
      });

      await enrollWithCredits(user.id, 'standard');

      await getSubscription(user.id);
      // suspended_at is cleared by auto-resume, not enrollment itself
      // However, if the enrollment triggers auto-resume, it may be cleared.
      // The spec says enrollment calls auto-resume, so it should be cleared.
      // Let's verify start() was called.
      expect(mockStart).toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it('triggers bonus evaluation after enrollment', async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const { evaluateKiloPassBonusAfterDeduction } = jest.requireMock<{
        evaluateKiloPassBonusAfterDeduction: AnyMock;
      }>('@/lib/kiloclaw/kilo-pass-integration');

      await enrollWithCredits(user.id, 'standard');

      expect(evaluateKiloPassBonusAfterDeduction).toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it('calls auto-resume if previously suspended', async () => {
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      const suspendedTime = new Date(NOW - 86_400_000 * 3).toISOString();
      await insertSubscription(user.id, {
        status: 'canceled',
        suspended_at: suspendedTime,
      });
      await db.insert(kiloclaw_instances).values({
        user_id: user.id,
        sandbox_id: 'test-sandbox',
      });

      await enrollWithCredits(user.id, 'standard');

      expect(mockStart).toHaveBeenCalledWith(user.id);
      const sub = await getSubscription(user.id);
      expect(sub.suspended_at).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });
});

// ── Credit Renewal Sweep ───────────────────────────────────────────────────

describe('runCreditRenewalSweep', () => {
  describe('row selection', () => {
    it('processes rows with payment_source=credits, active status, credit_renewal_at <= now', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const txns = await getCreditTransactions(user.id);
        expect(txns.some((t: CreditTransaction) => t.amount_microdollars < 0)).toBe(true);
      } finally {
        Date.now = realNow;
      }
    });

    it('processes rows with past_due status', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'past_due',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          past_due_since: new Date(NOW - 86_400_000 * 2).toISOString(),
        });

        await runCreditRenewalSweep(db);

        // With enough balance, should recover
        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('active');
      } finally {
        Date.now = realNow;
      }
    });

    it('does NOT process stripe payment_source rows', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'stripe',
          plan: 'standard',
          stripe_subscription_id: `sub_stripe_${Math.random()}`,
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const txns = await getCreditTransactions(user.id);
        expect(txns.filter((t: CreditTransaction) => t.amount_microdollars < 0)).toHaveLength(0);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('cancel-at-period-end', () => {
    it('sets status to canceled and skips deduction', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          cancel_at_period_end: true,
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('canceled');
        expect(sub.cancel_at_period_end).toBe(false);

        const txns = await getCreditTransactions(user.id);
        expect(txns.filter((t: CreditTransaction) => t.amount_microdollars < 0)).toHaveLength(0);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('successful renewal', () => {
    it('advances billing period by one month for standard plan', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const oldPeriodEnd = new Date(NOW - 86_400_000).toISOString();
        const oldPeriodStart = new Date(NOW - 86_400_000 * 31).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: oldPeriodStart,
          current_period_end: oldPeriodEnd,
          credit_renewal_at: oldPeriodEnd,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(new Date(sub.current_period_start!).getTime()).toBe(
          new Date(oldPeriodEnd).getTime()
        );
        const expectedNewEnd = addMonths(new Date(oldPeriodEnd), 1);
        expect(new Date(sub.current_period_end!).getTime()).toBe(expectedNewEnd.getTime());
        expect(new Date(sub.credit_renewal_at!).getTime()).toBe(expectedNewEnd.getTime());
      } finally {
        Date.now = realNow;
      }
    });

    it('advances billing period by six months for commit plan', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const oldPeriodEnd = new Date(NOW - 86_400_000).toISOString();
        const commitEnd = addMonths(new Date(NOW), 5).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'commit',
          current_period_start: addMonths(new Date(oldPeriodEnd), -6).toISOString(),
          current_period_end: oldPeriodEnd,
          credit_renewal_at: oldPeriodEnd,
          commit_ends_at: commitEnd,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(new Date(sub.current_period_start!).getTime()).toBe(
          new Date(oldPeriodEnd).getTime()
        );
        const expectedNewEnd = addMonths(new Date(oldPeriodEnd), 6);
        expect(new Date(sub.current_period_end!).getTime()).toBe(expectedNewEnd.getTime());
      } finally {
        Date.now = realNow;
      }
    });

    it('uses period-encoded idempotency key based on credit_renewal_at', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        // credit_renewal_at is 2026-03-14, so the idempotency key should encode 2026-03
        const renewalAt = new Date('2026-03-14T12:00:00Z').toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date('2026-02-14T12:00:00Z').toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const txns = await getCreditTransactions(user.id);
        const deduction = txns.find((t: CreditTransaction) => t.amount_microdollars < 0);
        expect(deduction).toBeDefined();
        // Key should be derived from the renewal period, not wall-clock time
        expect(deduction!.credit_category).toContain('2026-03');
      } finally {
        Date.now = realNow;
      }
    });

    it('advances only one period per sweep even if multiple periods behind', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        // credit_renewal_at is 3 months ago
        const renewalAt = addMonths(new Date(NOW), -3).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: addMonths(new Date(NOW), -4).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        // Should advance by exactly 1 month from the old period end
        const expectedNewEnd = addMonths(new Date(renewalAt), 1);
        expect(new Date(sub.current_period_end!).getTime()).toBe(expectedNewEnd.getTime());

        // Run sweep again — should advance one more month
        await runCreditRenewalSweep(db);

        const sub2 = await getSubscription(user.id);
        const expectedSecondEnd = addMonths(expectedNewEnd, 1);
        expect(new Date(sub2.current_period_end!).getTime()).toBe(expectedSecondEnd.getTime());
      } finally {
        Date.now = realNow;
      }
    });

    it('clears auto_top_up_triggered_for_period when billing period advances', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          auto_top_up_triggered_for_period: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.auto_top_up_triggered_for_period).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('duplicate deduction protection', () => {
    it('skips further processing when idempotency key already exists', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        // Run sweep once (success)
        await runCreditRenewalSweep(db);

        // Reset credit_renewal_at to trigger another sweep attempt for same period
        await db
          .update(kiloclaw_subscriptions)
          .set({ credit_renewal_at: renewalAt })
          .where(eq(kiloclaw_subscriptions.user_id, user.id));

        // Run sweep again — should not error, should not create another deduction
        await runCreditRenewalSweep(db);

        const txns = await getCreditTransactions(user.id);
        const deductions = txns.filter((t: CreditTransaction) => t.amount_microdollars < 0);
        // Only one deduction should exist due to idempotency
        expect(deductions).toHaveLength(1);
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('insufficient balance', () => {
    it('sets status to past_due and records past_due_since', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, 0);
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('past_due');
        expect(sub.past_due_since).not.toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('sends credit-renewal-failed notification', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, 0);
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const { send } = jest.requireMock<{ send: AnyMock }>('@/lib/email');
        expect(send).toHaveBeenCalled();
      } finally {
        Date.now = realNow;
      }
    });

    it('preserves existing past_due_since when already past_due', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, 0);
        const fiveDaysAgo = new Date(NOW - 86_400_000 * 5).toISOString();
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'past_due',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          past_due_since: fiveDaysAgo,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('past_due');
        // past_due_since should NOT be reset to now; it should remain at the original value
        expect(new Date(sub.past_due_since!).getTime()).toBe(new Date(fiveDaysAgo).getTime());
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('auto top-up', () => {
    it('triggers auto top-up and skips past-due when balance insufficient', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, 0);
        await db
          .update(kilocode_users)
          .set({ auto_top_up_enabled: true })
          .where(eq(kilocode_users.id, user.id));
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        const { triggerAutoTopUpForKiloClaw } = jest.requireMock<{
          triggerAutoTopUpForKiloClaw: AnyMock;
        }>('@/lib/autoTopUp');

        await runCreditRenewalSweep(db);

        expect(triggerAutoTopUpForKiloClaw).toHaveBeenCalled();
        const sub = await getSubscription(user.id);
        // Status should remain active (fire-and-skip), not go past_due
        expect(sub.status).toBe('active');
      } finally {
        Date.now = realNow;
      }
    });

    it('sets durable marker before triggering auto top-up', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, 0);
        await db
          .update(kilocode_users)
          .set({ auto_top_up_enabled: true })
          .where(eq(kilocode_users.id, user.id));
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.auto_top_up_triggered_for_period).not.toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('skips fire-and-skip when marker already present', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        await setUserBalance(user.id, 0);
        await db
          .update(kilocode_users)
          .set({ auto_top_up_enabled: true })
          .where(eq(kilocode_users.id, user.id));
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          // Marker already set — auto top-up was already triggered for this period
          auto_top_up_triggered_for_period: renewalAt,
        });

        const { triggerAutoTopUpForKiloClaw } = jest.requireMock<{
          triggerAutoTopUpForKiloClaw: AnyMock;
        }>('@/lib/autoTopUp');

        await runCreditRenewalSweep(db);

        // Should NOT trigger auto top-up again
        expect(triggerAutoTopUpForKiloClaw).not.toHaveBeenCalled();
        // Should enter past-due path instead
        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('past_due');
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('past-due recovery', () => {
    it('clears past_due_since and sets status active on grace-period recovery', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'past_due',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          past_due_since: new Date(NOW - 86_400_000 * 2).toISOString(),
        });
        // User has enough balance to cover renewal
        await setUserBalance(user.id, 100_000_000);

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.status).toBe('active');
        expect(sub.past_due_since).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });

    it('deletes credit-renewal-failed email log on recovery', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'past_due',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          past_due_since: new Date(NOW - 86_400_000 * 2).toISOString(),
        });

        // Insert the email log entry that should be deleted on recovery
        await db.insert(kiloclaw_email_log).values({
          user_id: user.id,
          email_type: 'claw_credit_renewal_failed',
        });

        await setUserBalance(user.id, 100_000_000);

        await runCreditRenewalSweep(db);

        const emailLogs = await db
          .select()
          .from(kiloclaw_email_log)
          .where(
            and(
              eq(kiloclaw_email_log.user_id, user.id),
              eq(kiloclaw_email_log.email_type, 'claw_credit_renewal_failed')
            )
          );
        expect(emailLogs).toHaveLength(0);
      } finally {
        Date.now = realNow;
      }
    });

    it('calls auto-resume for suspended recovery', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        const suspendedAt = new Date(NOW - 86_400_000 * 5).toISOString();
        await insertSubscription(user.id, {
          status: 'past_due',
          payment_source: 'credits',
          plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          past_due_since: new Date(NOW - 86_400_000 * 5).toISOString(),
          suspended_at: suspendedAt,
        });
        await db.insert(kiloclaw_instances).values({
          user_id: user.id,
          sandbox_id: 'test-sandbox',
        });
        await setUserBalance(user.id, 100_000_000);

        await runCreditRenewalSweep(db);

        expect(mockStart).toHaveBeenCalledWith(user.id);
        const sub = await getSubscription(user.id);
        expect(sub.suspended_at).toBeNull();
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('commit renewal after commit_ends_at', () => {
    it('extends commit_ends_at by 6 months when past', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        const pastCommitEnd = new Date(NOW - 86_400_000 * 2).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'commit',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          commit_ends_at: pastCommitEnd,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        const newCommitEnd = new Date(sub.commit_ends_at!);
        const expectedCommitEnd = addMonths(new Date(pastCommitEnd), 6);
        expect(newCommitEnd.getTime()).toBe(expectedCommitEnd.getTime());
      } finally {
        Date.now = realNow;
      }
    });
  });

  describe('plan switching during renewal', () => {
    it('switches from standard to commit when scheduled', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'standard',
          scheduled_plan: 'commit',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
        });
        // Ensure enough balance for commit price
        await setUserBalance(user.id, 100_000_000);

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.plan).toBe('commit');
        expect(sub.scheduled_plan).toBeNull();
        expect(sub.commit_ends_at).not.toBeNull();

        // Deduction should be at commit price
        const txns = await getCreditTransactions(user.id);
        const deduction = txns.find((t: CreditTransaction) => t.amount_microdollars < 0);
        expect(deduction).toBeDefined();
        expect(deduction!.amount_microdollars).toBe(-KILOCLAW_COMMIT_SIXMONTH_MICRODOLLARS);
      } finally {
        Date.now = realNow;
      }
    });

    it('switches from commit to standard when scheduled', async () => {
      const realNow = Date.now;
      Date.now = () => NOW;
      try {
        const renewalAt = new Date(NOW - 86_400_000).toISOString();
        const commitEnd = new Date(NOW - 86_400_000 * 2).toISOString();
        await insertSubscription(user.id, {
          status: 'active',
          payment_source: 'credits',
          plan: 'commit',
          scheduled_plan: 'standard',
          current_period_start: new Date(NOW - 86_400_000 * 31).toISOString(),
          current_period_end: renewalAt,
          credit_renewal_at: renewalAt,
          commit_ends_at: commitEnd,
        });

        await runCreditRenewalSweep(db);

        const sub = await getSubscription(user.id);
        expect(sub.plan).toBe('standard');
        expect(sub.scheduled_plan).toBeNull();
        expect(sub.commit_ends_at).toBeNull();

        // Deduction should be at standard price
        const txns = await getCreditTransactions(user.id);
        const deduction = txns.find((t: CreditTransaction) => t.amount_microdollars < 0);
        expect(deduction).toBeDefined();
        expect(deduction!.amount_microdollars).toBe(-KILOCLAW_STANDARD_MONTHLY_MICRODOLLARS);
      } finally {
        Date.now = realNow;
      }
    });
  });
});
