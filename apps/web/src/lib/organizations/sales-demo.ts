import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  compute_usage_charge,
  credit_transactions,
  exa_usage_log,
  kilocode_users,
  microdollar_usage,
  organization_invitations,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, asc, eq, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';

export const SALES_DEMO_MEMBER_COUNT = 25;
export const SALES_DEMO_CREDIT_USD = 50;

export const ALREADY_OWNS_DEMO = 'ALREADY_OWNS_DEMO';
export const NOT_LIVE_SALES_DEMO = 'NOT_LIVE_SALES_DEMO';

export function salesDemoMemberId(n: number): string {
  return `sales-demo-member-${String(n).padStart(2, '0')}`;
}

export function salesDemoMemberEmail(n: number): string {
  return `${salesDemoMemberId(n)}@example.com`;
}

export function salesDemoMemberName(n: number): string {
  return `Demo Member ${String(n).padStart(2, '0')}`;
}

export function demoOrganizationSettings(now: Date) {
  return {
    enable_usage_limits: false,
    code_indexing_enabled: true,
    suppress_trial_messaging: true,
    recommendations_digest_enabled: true,
    is_sales_demo: true,
    sales_demo_last_reset_at: now.toISOString(),
  };
}

/**
 * Ensures the 25 shared demo member `kilocode_users` rows exist.
 * Returns the 25 stable ids.
 */
export async function ensureSalesDemoUsers(txn: DrizzleTransaction): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 1; n <= SALES_DEMO_MEMBER_COUNT; n++) {
    const id = salesDemoMemberId(n);
    const email = salesDemoMemberEmail(n);
    const padded = String(n).padStart(2, '0');
    await txn
      .insert(kilocode_users)
      .values({
        id,
        google_user_email: email,
        google_user_name: salesDemoMemberName(n),
        google_user_image_url: `https://example.com/sales-demo-member-${padded}.png`,
        stripe_customer_id: `cus_sales_demo_${padded}`,
        normalized_email: email,
      })
      .onConflictDoUpdate({
        target: kilocode_users.id,
        set: {
          google_user_email: email,
          google_user_name: salesDemoMemberName(n),
          google_user_image_url: `https://example.com/sales-demo-member-${padded}.png`,
          normalized_email: email,
        },
      });
    ids.push(id);
  }
  return ids;
}

/**
 * Finds the live sales demo org created by the given user, if any.
 */
export async function findLiveSalesDemoOwnedBy(
  userId: string,
  txn?: DrizzleTransaction
): Promise<Organization | null> {
  const dbOrTx = txn ?? db;
  const [row] = await dbOrTx
    .select()
    .from(organizations)
    .where(
      and(
        eq(organizations.created_by_kilo_user_id, userId),
        isNull(organizations.deleted_at),
        sql`${organizations.settings}->>'is_sales_demo' = 'true'`
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * Finds the first live sales demo org the given user is a member of.
 */
export async function findLiveSalesDemoForUser(
  userId: string,
  txn?: DrizzleTransaction
): Promise<Organization | null> {
  const dbOrTx = txn ?? db;
  const rows = await dbOrTx
    .select({ org: organizations })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organization_memberships.organization_id, organizations.id))
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        isNull(organizations.deleted_at),
        sql`${organizations.settings}->>'is_sales_demo' = 'true'`
      )
    )
    .orderBy(asc(organizations.created_at), asc(organizations.id))
    .limit(1);
  return rows[0]?.org ?? null;
}

export async function createSalesDemoOrganization(args: {
  targetUser: User;
  adminUser: User;
  txn: DrizzleTransaction;
}): Promise<Organization> {
  const { targetUser, adminUser, txn } = args;

  const existing = await findLiveSalesDemoOwnedBy(targetUser.id, txn);
  if (existing) {
    throw new Error(ALREADY_OWNS_DEMO, {
      cause: { organizationId: existing.id, organizationName: existing.name },
    });
  }

  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const [organization] = await txn
    .insert(organizations)
    .values({
      name: `Kilo Enterprise Demo (${targetUser.google_user_email})`,
      plan: 'enterprise',
      require_seats: false,
      created_by_kilo_user_id: targetUser.id,
      free_trial_end_at: oneYearFromNow.toISOString(),
      settings: demoOrganizationSettings(now),
    })
    .returning();

  if (!organization) {
    throw new Error('Failed to create sales demo organization');
  }

  await txn.insert(organization_memberships).values({
    organization_id: organization.id,
    kilo_user_id: targetUser.id,
    role: 'owner',
    invited_by: adminUser.id,
  });

  const demoIds = await ensureSalesDemoUsers(txn);
  for (const demoId of demoIds) {
    await addUserToOrganization(organization.id, demoId, 'member', txn);
  }

  const creditResult = await grantEntityCreditForCategory(
    { user: adminUser, organization },
    {
      credit_category: 'sales-demo',
      counts_as_selfservice: false,
      amount_usd: SALES_DEMO_CREDIT_USD,
      dbOrTx: txn,
    }
  );

  if (!creditResult.success) {
    throw new Error(`Failed to grant credits: ${creditResult.message}`);
  }

  return organization;
}

export async function restoreSalesDemoOrganization(args: {
  organizationId: string;
  actorUser: User;
  txn: DrizzleTransaction;
}): Promise<string> {
  const { organizationId, actorUser, txn } = args;

  if (!actorUser) {
    throw new Error('actorUser is required');
  }

  const [org] = await txn
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .for('update')
    .limit(1);

  if (!org || org.settings.is_sales_demo !== true) {
    throw new Error(NOT_LIVE_SALES_DEMO);
  }

  const ownerId = org.created_by_kilo_user_id;

  await txn.delete(microdollar_usage).where(eq(microdollar_usage.organization_id, organizationId));
  await txn.delete(exa_usage_log).where(eq(exa_usage_log.organization_id, organizationId));
  await txn
    .delete(compute_usage_charge)
    .where(eq(compute_usage_charge.organization_id, organizationId));
  await txn
    .delete(credit_transactions)
    .where(eq(credit_transactions.organization_id, organizationId));
  await txn
    .delete(organization_invitations)
    .where(eq(organization_invitations.organization_id, organizationId));

  const now = new Date();
  const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  await txn
    .update(organizations)
    .set({
      total_microdollars_acquired: 0,
      microdollars_used: 0,
      microdollars_balance: 0,
      auto_top_up_enabled: false,
      plan: 'enterprise',
      require_seats: false,
      free_trial_end_at: oneYearFromNow.toISOString(),
      settings: demoOrganizationSettings(now),
    })
    .where(eq(organizations.id, organizationId));

  const demoIds = await ensureSalesDemoUsers(txn);

  await txn
    .delete(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        ne(organization_memberships.kilo_user_id, ownerId ?? ''),
        notInArray(organization_memberships.kilo_user_id, demoIds)
      )
    );

  for (const demoId of demoIds) {
    await addUserToOrganization(organizationId, demoId, 'member', txn);
  }

  if (ownerId) {
    const [ownerMembership] = await txn
      .select({ kilo_user_id: organization_memberships.kilo_user_id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organizationId),
          eq(organization_memberships.kilo_user_id, ownerId)
        )
      )
      .limit(1);

    if (!ownerMembership) {
      await txn.insert(organization_memberships).values({
        organization_id: organizationId,
        kilo_user_id: ownerId,
        role: 'owner',
      });
    }
  }

  const [reloadedOrg] = await txn
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!reloadedOrg) {
    throw new Error(`Organization ${organizationId} not found after reset`);
  }

  const creditResult = await grantEntityCreditForCategory(
    { user: actorUser, organization: reloadedOrg },
    {
      credit_category: 'sales-demo',
      counts_as_selfservice: false,
      amount_usd: SALES_DEMO_CREDIT_USD,
      dbOrTx: txn,
    }
  );

  if (!creditResult.success) {
    throw new Error(`Failed to grant credits: ${creditResult.message}`);
  }

  return organizationId;
}
