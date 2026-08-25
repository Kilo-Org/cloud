import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  organization_memberships,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';
import {
  salesDemoMemberId,
  salesDemoMemberEmail,
  salesDemoMemberName,
} from '@/lib/organizations/sales-demo';
import type { User } from '@kilocode/db/schema';

describe('sales demo router', () => {
  let admin: User;
  let nonAdmin: User;
  let target: User;
  let target2: User;
  let target3: User;

  let firstOrgId: string;
  let firstOrgName: string;
  let secondOrgId: string;
  let thirdOrgId: string;
  let normalOrgId: string;

  beforeAll(async () => {
    admin = await insertTestUser({
      google_user_email: 'sales-demo-admin@kilocode.ai',
      google_user_name: 'Sales Demo Admin',
      is_admin: true,
    });

    nonAdmin = await insertTestUser({
      google_user_email: 'sales-demo-non-admin@example.com',
      google_user_name: 'Sales Demo Non Admin',
      is_admin: false,
    });

    target = await insertTestUser({
      google_user_email: 'sales-demo-target@kilocode.ai',
      google_user_name: 'Sales Demo Target',
      normalized_email: 'sales-demo-target@kilocode.ai',
    });

    target2 = await insertTestUser({
      google_user_email: 'sales-demo-target-2@kilocode.ai',
      google_user_name: 'Sales Demo Target Two',
      normalized_email: 'sales-demo-target-2@kilocode.ai',
    });

    target3 = await insertTestUser({
      google_user_email: 'sales-demo-target-3@kilocode.ai',
      google_user_name: 'Sales Demo Target Three',
      normalized_email: 'sales-demo-target-3@kilocode.ai',
    });
  });

  afterAll(async () => {
    const orgIds = [firstOrgId, secondOrgId, thirdOrgId, normalOrgId].filter(Boolean);
    if (orgIds.length > 0) {
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
        .delete(organization_memberships)
        .where(inArray(organization_memberships.organization_id, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }

    const demoIds = Array.from({ length: 25 }, (_, i) => salesDemoMemberId(i + 1));
    await db
      .delete(kilocode_users)
      .where(
        inArray(kilocode_users.id, [
          admin.id,
          nonAdmin.id,
          target.id,
          target2.id,
          target3.id,
          ...demoIds,
        ])
      );
  });

  it('rejects create for non-admin callers with FORBIDDEN', async () => {
    const caller = await createCallerForUser(nonAdmin.id);
    await expect(
      caller.admin.salesDemo.create({ email: target.google_user_email })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects create for a non allow-listed email with BAD_REQUEST', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.salesDemo.create({ email: 'not-an-employee@gmail.com' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringMatching(/@kilocode\.ai.*@anaconda\.com/),
    });
  });

  it('rejects create for a missing user with NOT_FOUND', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.salesDemo.create({ email: 'missing-user@kilocode.ai' })
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('sign in once'),
    });
  });

  it('creates an enterprise sales demo org with $50 and 26 members', async () => {
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.salesDemo.create({ email: target.google_user_email });

    firstOrgId = result.organizationId;
    firstOrgName = result.organizationName;

    const [org] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, firstOrgId))
      .limit(1);

    expect(org).toBeDefined();
    expect(org.plan).toBe('enterprise');
    expect(org.require_seats).toBe(false);
    expect(org.settings.is_sales_demo).toBe(true);
    expect(org.settings.suppress_trial_messaging).toBe(true);
    expect(org.created_by_kilo_user_id).toBe(target.id);
    expect(Number(org.total_microdollars_acquired) - Number(org.microdollars_used)).toBe(
      50_000_000
    );

    const [ownerMembership] = await db
      .select()
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, firstOrgId),
          eq(organization_memberships.kilo_user_id, target.id)
        )
      )
      .limit(1);
    expect(ownerMembership?.role).toBe('owner');

    const members = await db
      .select({
        kilo_user_id: organization_memberships.kilo_user_id,
        is_bot: kilocode_users.is_bot,
        google_user_email: kilocode_users.google_user_email,
        google_user_name: kilocode_users.google_user_name,
      })
      .from(organization_memberships)
      .innerJoin(kilocode_users, eq(organization_memberships.kilo_user_id, kilocode_users.id))
      .where(eq(organization_memberships.organization_id, firstOrgId));

    const nonBots = members.filter(member => !member.is_bot);
    expect(nonBots).toHaveLength(26);

    for (let n = 1; n <= 25; n++) {
      const member = nonBots.find(m => m.kilo_user_id === salesDemoMemberId(n));
      expect(member).toBeDefined();
      expect(member?.google_user_email).toBe(salesDemoMemberEmail(n));
      expect(member?.google_user_name).toBe(salesDemoMemberName(n));
    }
  });

  it('rejects a second create for the same target with CONFLICT', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.salesDemo.create({ email: target.google_user_email })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: `ALREADY_OWNS_DEMO:${firstOrgId}:${firstOrgName}`,
    });

    const liveDemos = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.created_by_kilo_user_id, target.id),
          sql`${organizations.settings}->>'is_sales_demo' = 'true'`,
          sql`${organizations.deleted_at} IS NULL`
        )
      );
    expect(liveDemos).toHaveLength(1);
  });

  it('creates a second org for a second target reusing the same 25 demo users', async () => {
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.salesDemo.create({ email: target2.google_user_email });
    secondOrgId = result.organizationId;

    expect(secondOrgId).not.toBe(firstOrgId);

    const demoRows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(sql`${kilocode_users.id} LIKE 'sales-demo-member-%'`);
    expect(demoRows).toHaveLength(25);
  });

  it('allows exactly one of two concurrent creates for the same target', async () => {
    const caller = await createCallerForUser(admin.id);

    const results = await Promise.allSettled([
      caller.admin.salesDemo.create({ email: target3.google_user_email }),
      caller.admin.salesDemo.create({ email: target3.google_user_email }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = fulfilled[0] as PromiseFulfilledResult<{
      organizationId: string;
      organizationName: string;
    }>;
    thirdOrgId = winner.value.organizationId;

    const loser = rejected[0] as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: 'CONFLICT' });

    const liveDemos = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.created_by_kilo_user_id, target3.id),
          sql`${organizations.settings}->>'is_sales_demo' = 'true'`,
          sql`${organizations.deleted_at} IS NULL`
        )
      );
    expect(liveDemos).toHaveLength(1);
  });

  it('resets a dirty demo org back to the same id and $50', async () => {
    const caller = await createCallerForUser(admin.id);

    const [before] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, firstOrgId))
      .limit(1);

    await db.insert(microdollar_usage).values({
      kilo_user_id: target.id,
      cost: 1_000_000,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      organization_id: firstOrgId,
    });

    const extraGrant = await grantEntityCreditForCategory(
      { user: admin, organization: before },
      { credit_category: 'sales-demo', counts_as_selfservice: false, amount_usd: 10 }
    );
    expect(extraGrant.success).toBe(true);

    await db.insert(organization_memberships).values({
      organization_id: firstOrgId,
      kilo_user_id: nonAdmin.id,
      role: 'member',
    });

    await db
      .update(organization_memberships)
      .set({ role: 'admin' })
      .where(
        and(
          eq(organization_memberships.organization_id, firstOrgId),
          eq(organization_memberships.kilo_user_id, salesDemoMemberId(1))
        )
      );

    await db
      .update(organization_memberships)
      .set({ role: 'member' })
      .where(
        and(
          eq(organization_memberships.organization_id, firstOrgId),
          eq(organization_memberships.kilo_user_id, target.id)
        )
      );

    await db.insert(microdollar_usage_daily).values({
      kilo_user_id: target.id,
      organization_id: firstOrgId,
      usage_date: '2026-08-25',
    });

    await db.insert(organization_user_usage).values({
      organization_id: firstOrgId,
      kilo_user_id: target.id,
      usage_date: sql`CURRENT_DATE`,
      limit_type: 'daily',
      microdollar_usage: 1_000_000,
    });

    const result = await caller.admin.salesDemo.reset({ organizationId: firstOrgId });
    expect(result.organizationId).toBe(firstOrgId);

    const [after] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, firstOrgId))
      .limit(1);

    expect(Number(after.microdollars_used)).toBe(0);
    expect(Number(after.total_microdollars_acquired) - Number(after.microdollars_used)).toBe(
      50_000_000
    );
    expect(after.settings.is_sales_demo).toBe(true);
    expect(after.settings.enable_usage_limits).toBe(false);
    expect(after.settings.code_indexing_enabled).toBe(true);
    expect(after.settings.suppress_trial_messaging).toBe(true);
    expect(after.settings.recommendations_digest_enabled).toBe(true);
    expect(typeof after.settings.sales_demo_last_reset_at).toBe('string');

    const strayMemberships = await db
      .select()
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, firstOrgId),
          eq(organization_memberships.kilo_user_id, nonAdmin.id)
        )
      );
    expect(strayMemberships).toHaveLength(0);

    const [demoMember01] = await db
      .select({ role: organization_memberships.role })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, firstOrgId),
          eq(organization_memberships.kilo_user_id, salesDemoMemberId(1))
        )
      )
      .limit(1);
    expect(demoMember01?.role).toBe('member');

    const [ownerMembership] = await db
      .select({ role: organization_memberships.role })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, firstOrgId),
          eq(organization_memberships.kilo_user_id, target.id)
        )
      )
      .limit(1);
    expect(ownerMembership?.role).toBe('owner');

    const dailyProjections = await db
      .select({ id: microdollar_usage_daily.id })
      .from(microdollar_usage_daily)
      .where(eq(microdollar_usage_daily.organization_id, firstOrgId));
    expect(dailyProjections).toHaveLength(0);

    const orgUsageProjections = await db
      .select({ id: organization_user_usage.id })
      .from(organization_user_usage)
      .where(eq(organization_user_usage.organization_id, firstOrgId));
    expect(orgUsageProjections).toHaveLength(0);

    const txns = await db
      .select({ amount_microdollars: credit_transactions.amount_microdollars })
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, firstOrgId));
    const total = txns.reduce((acc, tx) => acc + Number(tx.amount_microdollars), 0);
    expect(total).toBe(50_000_000);
  });

  it('rejects reset for a normal org with NOT_FOUND', async () => {
    const caller = await createCallerForUser(admin.id);
    const normalOrg = await createOrganization('Sales Demo Normal Org', target.id);
    normalOrgId = normalOrg.id;

    await expect(
      caller.admin.salesDemo.reset({ organizationId: normalOrg.id })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
