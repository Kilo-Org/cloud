import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
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
import { createSalesDemoOrganization, salesDemoMemberId } from '@/lib/organizations/sales-demo';
import type { User } from '@kilocode/db/schema';

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

describe('sales demo admin list', () => {
  let admin: User;
  let target: User;

  beforeAll(async () => {
    await deleteAllSalesDemoOrgs();

    admin = await insertTestUser({
      google_user_email: 'sales-demo-list-admin@kilocode.ai',
      google_user_name: 'Sales Demo List Admin',
      is_admin: true,
    });

    target = await insertTestUser({
      google_user_email: 'sales-demo-list-owner@kilocode.ai',
      google_user_name: 'Sales Demo List Owner',
      normalized_email: 'sales-demo-list-owner@kilocode.ai',
    });
  });

  afterAll(async () => {
    await deleteAllSalesDemoOrgs();
    const demoIds = Array.from({ length: 25 }, (_, i) => salesDemoMemberId(i + 1));
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [admin.id, target.id, ...demoIds]));
  });

  test('lists a live sales-demo org with no seats purchase under paying/active filters', async () => {
    const demoOrg = await db.transaction(async txn =>
      createSalesDemoOrganization({ targetUser: target, adminUser: admin, txn })
    );

    const caller = await createCallerForUser(admin.id);
    const result = await caller.organizations.admin.list({
      mode: 'paying',
      stripe_status: 'active',
      search: demoOrg.name,
      page: 1,
      limit: 25,
      sortBy: 'name',
      sortOrder: 'desc',
    });

    expect(result.organizations.map(organization => organization.id)).toContain(demoOrg.id);
  });
});
