import { describe, test, expect, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { exa_monthly_usage, kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { getExaMonthlyUsage, recordExaUsage } from './exa-usage';

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

  describe('getExaMonthlyUsage', () => {
    test('returns 0 when no usage exists', async () => {
      const user = await insertTestUser();
      const result = await getExaMonthlyUsage(user.id);
      expect(result).toBe(0);
    });

    test('returns the total from the counter table for the current month', async () => {
      const user = await insertTestUser();

      // Seed a counter row for the current month
      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`date_trunc('month', now())::date`.mapWith(String),
        total_cost_microdollars: 5_000_000,
        total_charged_microdollars: 0,
        request_count: 10,
      });

      const result = await getExaMonthlyUsage(user.id);
      expect(result).toBe(5_000_000);
    });

    test('ignores usage from prior months', async () => {
      const user = await insertTestUser();

      // Seed a counter row for last month
      await db.insert(exa_monthly_usage).values({
        kilo_user_id: user.id,
        month: sql`(date_trunc('month', now()) - interval '1 month')::date`.mapWith(String),
        total_cost_microdollars: 9_000_000,
        total_charged_microdollars: 0,
        request_count: 50,
      });

      const result = await getExaMonthlyUsage(user.id);
      expect(result).toBe(0);
    });
  });

  describe('recordExaUsage', () => {
    test('creates a counter row on first request', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: false,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].total_cost_microdollars).toBe(7000);
      expect(rows[0].total_charged_microdollars).toBe(0);
      expect(rows[0].request_count).toBe(1);
    });

    test('increments existing counter on subsequent requests', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: false,
      });

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/contents',
        costMicrodollars: 5000,
        chargedToBalance: false,
      });

      const rows = await db
        .select()
        .from(exa_monthly_usage)
        .where(eq(exa_monthly_usage.kilo_user_id, user.id));

      expect(rows).toHaveLength(1);
      expect(rows[0].total_cost_microdollars).toBe(8000);
      expect(rows[0].request_count).toBe(2);
    });

    test('tracks charged amount separately when chargedToBalance is true', async () => {
      const user = await insertTestUser();

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 5000,
        chargedToBalance: false,
      });

      await recordExaUsage({
        userId: user.id,
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 3000,
        chargedToBalance: true,
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
      });

      const [updated] = await db
        .select({ microdollars_used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, user.id));

      expect(updated.microdollars_used).toBe(0);
    });
  });
});
