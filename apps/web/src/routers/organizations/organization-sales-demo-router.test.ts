import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
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
import { and, eq, inArray } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createSalesDemoOrganization, salesDemoMemberId } from '@/lib/organizations/sales-demo';
import { createOrganization } from '@/lib/organizations/organizations';
import type { User } from '@kilocode/db/schema';

describe('organization sales demo reset router', () => {
  let admin: User;
  let owner: User;
  let normalOwner: User;
  let demoOrgId: string;
  let demoOrgName: string;
  let normalOrgId: string;

  beforeAll(async () => {
    admin = await insertTestUser({
      google_user_email: 'org-sales-demo-reset-admin@kilocode.ai',
      google_user_name: 'Org Sales Demo Reset Admin',
      is_admin: true,
    });

    owner = await insertTestUser({
      google_user_email: 'org-sales-demo-reset-owner@kilocode.ai',
      google_user_name: 'Org Sales Demo Reset Owner',
      normalized_email: 'org-sales-demo-reset-owner@kilocode.ai',
    });

    normalOwner = await insertTestUser({
      google_user_email: 'org-sales-demo-reset-normal-owner@kilocode.ai',
      google_user_name: 'Org Sales Demo Reset Normal Owner',
      normalized_email: 'org-sales-demo-reset-normal-owner@kilocode.ai',
    });

    const demoOrg = await db.transaction(txn =>
      createSalesDemoOrganization({ targetUser: owner, adminUser: admin, txn })
    );
    demoOrgId = demoOrg.id;
    demoOrgName = demoOrg.name;

    const normalOrg = await createOrganization('Org Sales Demo Reset Normal Org', normalOwner.id);
    normalOrgId = normalOrg.id;
  });

  afterAll(async () => {
    const orgIds = [demoOrgId, normalOrgId].filter(Boolean);
    if (orgIds.length > 0) {
      const usageIds = db
        .select({ id: microdollar_usage.id })
        .from(microdollar_usage)
        .where(inArray(microdollar_usage.organization_id, orgIds));
      await db
        .delete(microdollar_usage_metadata)
        .where(inArray(microdollar_usage_metadata.id, usageIds));
      await db.delete(exa_usage_log).where(inArray(exa_usage_log.organization_id, orgIds));
      await db
        .delete(compute_usage_charge)
        .where(inArray(compute_usage_charge.organization_id, orgIds));
      await db
        .delete(credit_transactions)
        .where(inArray(credit_transactions.organization_id, orgIds));
      await db.delete(microdollar_usage).where(inArray(microdollar_usage.organization_id, orgIds));
      await db
        .delete(microdollar_usage_daily)
        .where(inArray(microdollar_usage_daily.organization_id, orgIds));
      await db
        .delete(organization_user_usage)
        .where(inArray(organization_user_usage.organization_id, orgIds));
      await db
        .delete(organization_user_limits)
        .where(inArray(organization_user_limits.organization_id, orgIds));
      await db
        .delete(organization_memberships)
        .where(inArray(organization_memberships.organization_id, orgIds));
      await db
        .delete(sales_demo_spend_ledger)
        .where(inArray(sales_demo_spend_ledger.organization_id, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }

    const demoIds = Array.from({ length: 25 }, (_, i) => salesDemoMemberId(i + 1));
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [admin.id, owner.id, normalOwner.id, ...demoIds]));
  });

  test('owner of a live demo can reset and the org stays at $25.03 with populated usage', async () => {
    const caller = await createCallerForUser(owner.id);
    const result = await caller.organizations.salesDemo.reset({ organizationId: demoOrgId });

    expect(result.organizationId).toBe(demoOrgId);
    expect(result.organizationName).toBe(demoOrgName);

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, demoOrgId))
      .limit(1);

    expect(Number(org.total_microdollars_acquired) - Number(org.microdollars_used)).toBe(
      25_030_000
    );
    expect(Number(org.microdollars_balance)).toBe(25_030_000);
    expect(org.settings.is_sales_demo).toBe(true);

    const usageRows = await db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(eq(microdollar_usage.organization_id, demoOrgId));
    expect(usageRows.length).toBeGreaterThan(0);
  });

  test('a demo member gets UNAUTHORIZED, not FORBIDDEN', async () => {
    const caller = await createCallerForUser(salesDemoMemberId(1));
    await expect(
      caller.organizations.salesDemo.reset({ organizationId: demoOrgId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('a demo admin-role member gets UNAUTHORIZED, not FORBIDDEN', async () => {
    await db
      .update(organization_memberships)
      .set({ role: 'admin' })
      .where(
        and(
          eq(organization_memberships.organization_id, demoOrgId),
          eq(organization_memberships.kilo_user_id, salesDemoMemberId(2))
        )
      );

    const caller = await createCallerForUser(salesDemoMemberId(2));
    await expect(
      caller.organizations.salesDemo.reset({ organizationId: demoOrgId })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('a non-demo owner gets NOT_FOUND', async () => {
    const caller = await createCallerForUser(normalOwner.id);
    await expect(
      caller.organizations.salesDemo.reset({ organizationId: normalOrgId })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('create-then-owner-reset with no extra spend writes no ledger row', async () => {
    const caller = await createCallerForUser(owner.id);
    await caller.organizations.salesDemo.reset({ organizationId: demoOrgId });

    const ledger = await db
      .select({ id: sales_demo_spend_ledger.id })
      .from(sales_demo_spend_ledger)
      .where(eq(sales_demo_spend_ledger.organization_id, demoOrgId));
    expect(ledger).toHaveLength(0);
  });
});
