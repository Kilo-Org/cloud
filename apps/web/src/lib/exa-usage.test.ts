import { describe, test, expect, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { exa_monthly_usage, kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { getExaMonthlyUsage, getExaFreeAllowanceMicrodollars, recordExaUsage } from './exa-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@/lib/constants';

// Mock next/server's after function which requires request context
jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn((fn: () => Promise<void>) => {
    void fn();
  }),
}));

// Suppress Sentry in tests
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

describe('Exa Usage Tracking', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(exa_monthly_usage);
  });

  describe('getExaFreeAllowanceMicrodollars', () => {
    test('returns the global constant for any user', async () => {
      const user = await insertTestUser();
      expect(getExaFreeAllowanceMicrodollars(new Date(), user)).toBe(
        EXA_MONTHLY_ALLOWANCE_MICRODOLLARS
      );
    });
  });

  describe('getExaMonthlyUsage', () => {
    test('returns zero usage and null freeAllowance when no row exists', async () => {
      const user = await insertTestUser();
      const result = await getExaMonthlyUsage(user.id);
      expect(result).toEqual({ usage: 0, freeAllowance: null });
    });

    test('returns usage and stored freeAllowance for the current month', async () => {
      const user = await insertTestUser();

      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 5_000_000,
        total_charged_microdollars: 0,
        request_count: 10,
        free_allowance_microdollars: 10_000_000,
      });

      const result = await getExaMonthlyUsage(user.id);
      expect(result).toEqual({ usage: 5_000_000, freeAllowance: 10_000_000 });
    });

    test('ignores usage from prior months', async () => {
      const user = await insertTestUser();

      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`(date_trunc('month', now()) - interval '1 month')::date`.mapWith(String),
        total_cost_microdollars: 9_000_000,
        total_charged_microdollars: 0,
        request_count: 50,
        free_allowance_microdollars: 10_000_000,
      });

      const result = await getExaMonthlyUsage(user.id);
      expect(result).toEqual({ usage: 0, freeAllowance: null });
    });
  });

  describe('recordExaUsage', () => {
    test('creates a counter row on first request with free allowance', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].total_cost_microdollars).toBe(7000);
      expect(rows[0].total_charged_microdollars).toBe(0);
      expect(rows[0].request_count).toBe(1);
      expect(rows[0].free_allowance_microdollars).toBe(10_000_000);
    });

    test('increments existing counter on subsequent requests', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/contents',
        costMicrodollars: 5000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].total_cost_microdollars).toBe(8000);
      expect(rows[0].request_count).toBe(2);
    });

    test('locks in free allowance from first request of the month', async () => {
      const user = await insertTestUser();

      // First request sets the allowance to 10M
      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 1000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      // Second request passes a different allowance (simulating a mid-month change)
      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 2000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 20_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      // Allowance should stay at the first-request value (10M), not the second (20M)
      expect(rows[0].free_allowance_microdollars).toBe(10_000_000);
      expect(rows[0].total_cost_microdollars).toBe(3000);
    });

    test('tracks charged amount separately when chargedToBalance is true', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 5000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows[0].total_cost_microdollars).toBe(8000);
      expect(rows[0].total_charged_microdollars).toBe(3000);
    });

    test('deducts from personal balance when chargedToBalance is true and no org', async () => {
      const user = await insertTestUser({
        microdollars_used: 0,
        total_microdollars_acquired: 100_000_000,
      });

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const [updated] = await db
        .select({ microdollars_used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));

      expect(updated.microdollars_used).toBe(7000);
    });

    test('does not deduct from balance when chargedToBalance is false', async () => {
      const user = await insertTestUser({ microdollars_used: 0 });

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const [updated] = await db
        .select({ microdollars_used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));

      expect(updated.microdollars_used).toBe(0);
    });

    test('creates separate counter rows for personal and org usage', async () => {
      const user = await insertTestUser();
      const orgId = crypto.randomUUID();

      // Personal request
      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      // Org request
      await recordExaUsage({
        userId: user.id,
        organizationId: orgId,
        path: '/search',
        costMicrodollars: 5000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: 10_000_000,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(2);

      const personalRow = rows.find(r => r.organization_id === null);
      const orgRow = rows.find(r => r.organization_id === orgId);
      expect(personalRow!.total_cost_microdollars).toBe(3000);
      expect(orgRow!.total_cost_microdollars).toBe(5000);
    });

    test('getExaMonthlyUsage aggregates across personal and org rows', async () => {
      const user = await insertTestUser();
      const orgId = crypto.randomUUID();

      // Personal usage
      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 3_000_000,
        total_charged_microdollars: 0,
        request_count: 5,
        free_allowance_microdollars: 10_000_000,
      });

      // Org usage for the same user
      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        organization_id: orgId,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 5_000_000,
        total_charged_microdollars: 0,
        request_count: 10,
        free_allowance_microdollars: 10_000_000,
      });

      const result = await getExaMonthlyUsage(user.id);
      // Should sum both rows: 3M + 5M = 8M
      expect(result.usage).toBe(8_000_000);
      expect(result.freeAllowance).toBe(10_000_000);
    });
  });
});
