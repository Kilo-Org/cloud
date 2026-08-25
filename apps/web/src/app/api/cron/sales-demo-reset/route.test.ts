import { NextRequest } from 'next/server';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

// Create + reset each run a full 30-day populate step, so a single test case
// needs more than the default 5s budget.
jest.setTimeout(30_000);

import { db } from '@/lib/drizzle';
import {
  compute_usage_charge,
  credit_transactions,
  exa_usage_log,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_metadata,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
  sales_demo_spend_ledger,
} from '@kilocode/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createSalesDemoOrganization, salesDemoMemberId } from '@/lib/organizations/sales-demo';
import type { User } from '@kilocode/db/schema';
import { GET } from './route';

async function deleteAllSalesDemoOrgs() {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.settings}->>'is_sales_demo' = 'true'`);
  const ids = rows.map(row => row.id);
  if (ids.length === 0) return;
  const usageIds = db
    .select({ id: microdollar_usage.id })
    .from(microdollar_usage)
    .where(inArray(microdollar_usage.organization_id, ids));
  await db
    .delete(microdollar_usage_metadata)
    .where(inArray(microdollar_usage_metadata.id, usageIds));
  await db.delete(credit_transactions).where(inArray(credit_transactions.organization_id, ids));
  await db.delete(microdollar_usage).where(inArray(microdollar_usage.organization_id, ids));
  await db
    .delete(microdollar_usage_daily)
    .where(inArray(microdollar_usage_daily.organization_id, ids));
  await db
    .delete(organization_user_usage)
    .where(inArray(organization_user_usage.organization_id, ids));
  await db
    .delete(organization_user_limits)
    .where(inArray(organization_user_limits.organization_id, ids));
  await db.delete(exa_usage_log).where(inArray(exa_usage_log.organization_id, ids));
  await db.delete(compute_usage_charge).where(inArray(compute_usage_charge.organization_id, ids));
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, ids));
  await db
    .delete(sales_demo_spend_ledger)
    .where(inArray(sales_demo_spend_ledger.organization_id, ids));
  await db.delete(organizations).where(inArray(organizations.id, ids));
}

describe('GET /api/cron/sales-demo-reset', () => {
  let admin: User;
  let target: User;

  beforeAll(async () => {
    await deleteAllSalesDemoOrgs();

    admin = await insertTestUser({
      google_user_email: 'sales-demo-cron-admin@kilocode.ai',
      google_user_name: 'Sales Demo Cron Admin',
      is_admin: true,
    });

    target = await insertTestUser({
      google_user_email: 'sales-demo-cron-target@kilocode.ai',
      google_user_name: 'Sales Demo Cron Target',
      normalized_email: 'sales-demo-cron-target@kilocode.ai',
    });
  });

  afterAll(async () => {
    await deleteAllSalesDemoOrgs();
    const demoIds = Array.from({ length: 25 }, (_, i) => salesDemoMemberId(i + 1));
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [admin.id, target.id, ...demoIds]));
  });

  it('rejects requests without cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/sales-demo-reset', { method: 'GET' })
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects requests with invalid cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/sales-demo-reset', {
        method: 'GET',
        headers: { authorization: 'Bearer wrong-secret' },
      })
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('resets one dirty live demo org to $25.03 and reports reset 1', async () => {
    const org = await db.transaction(async tx =>
      createSalesDemoOrganization({ targetUser: target, adminUser: admin, txn: tx })
    );

    await db.insert(microdollar_usage).values({
      kilo_user_id: target.id,
      cost: 2_000_000,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      organization_id: org.id,
    });

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/sales-demo-reset', {
        method: 'GET',
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reset: 1, failed: 0 });

    const [reloaded] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, org.id))
      .limit(1);

    expect(Number(reloaded.microdollars_used)).toBeGreaterThan(0);
    expect(Number(reloaded.total_microdollars_acquired) - Number(reloaded.microdollars_used)).toBe(
      25_030_000
    );
  });
});
