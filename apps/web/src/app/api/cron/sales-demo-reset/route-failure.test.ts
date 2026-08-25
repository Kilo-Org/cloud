import { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  createSalesDemoOrganization,
  restoreSalesDemoOrganization,
  salesDemoMemberId,
} from '@/lib/organizations/sales-demo';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@/lib/organizations/sales-demo', () => ({
  ...jest.requireActual('@/lib/organizations/sales-demo'),
  restoreSalesDemoOrganization: jest.fn(),
}));

import { db } from '@/lib/drizzle';
import {
  compute_usage_charge,
  credit_transactions,
  exa_usage_log,
  kilocode_users,
  microdollar_usage,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { inArray, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { GET } from './route';

const mockedCaptureException = jest.mocked(captureException);
const mockedRestoreSalesDemoOrganization = jest.mocked(restoreSalesDemoOrganization);

async function deleteAllSalesDemoOrgs() {
  const rows = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.settings}->>'is_sales_demo' = 'true'`);
  const ids = rows.map(row => row.id);
  if (ids.length === 0) return;
  await db.delete(credit_transactions).where(inArray(credit_transactions.organization_id, ids));
  await db.delete(microdollar_usage).where(inArray(microdollar_usage.organization_id, ids));
  await db.delete(exa_usage_log).where(inArray(exa_usage_log.organization_id, ids));
  await db.delete(compute_usage_charge).where(inArray(compute_usage_charge.organization_id, ids));
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, ids));
  await db.delete(organizations).where(inArray(organizations.id, ids));
}

describe('GET /api/cron/sales-demo-reset failure handling', () => {
  let admin: User;
  let target: User;

  beforeAll(async () => {
    await deleteAllSalesDemoOrgs();

    admin = await insertTestUser({
      google_user_email: 'sales-demo-cron-failure-admin@kilocode.ai',
      google_user_name: 'Sales Demo Cron Failure Admin',
      is_admin: true,
    });

    target = await insertTestUser({
      google_user_email: 'sales-demo-cron-failure-target@kilocode.ai',
      google_user_name: 'Sales Demo Cron Failure Target',
      normalized_email: 'sales-demo-cron-failure-target@kilocode.ai',
    });
  });

  afterAll(async () => {
    await deleteAllSalesDemoOrgs();
    const demoIds = Array.from({ length: 25 }, (_, i) => salesDemoMemberId(i + 1));
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [admin.id, target.id, ...demoIds]));
  });

  it('logs, captures the exception, counts the failure, and still returns 200', async () => {
    mockedRestoreSalesDemoOrganization.mockRejectedValueOnce(new Error('boom'));

    await db.transaction(async tx =>
      createSalesDemoOrganization({ targetUser: target, adminUser: admin, txn: tx })
    );

    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/sales-demo-reset', {
        method: 'GET',
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reset: 0, failed: 1 });
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    expect(mockedRestoreSalesDemoOrganization).toHaveBeenCalledTimes(1);
  });
});
