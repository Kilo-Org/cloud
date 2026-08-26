import { createHash } from 'node:crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  compute_usage_charge,
  credit_transactions,
  exa_usage_log,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_metadata,
  organization_invitations,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
  sales_demo_spend_ledger,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { populateSalesDemoUsage } from './sales-demo-usage';

export const SALES_DEMO_MEMBER_COUNT = 25;
export const SALES_DEMO_REMAINING_MICRODOLLARS = 25_030_000;

export const ALREADY_OWNS_DEMO = 'ALREADY_OWNS_DEMO';
export const NOT_LIVE_SALES_DEMO = 'NOT_LIVE_SALES_DEMO';

/**
 * Fixed 25 human names for the demo members. Index `n - 1` aligns with
 * `salesDemoMemberId(n)` so member `01` uses the first entry.
 */
const SALES_DEMO_MEMBER_PROFILES: ReadonlyArray<{ first: string; last: string }> = [
  { first: 'Ava', last: 'Chen' },
  { first: 'Liam', last: 'Rodriguez' },
  { first: 'Sofia', last: 'Patel' },
  { first: 'Noah', last: 'Kim' },
  { first: 'Maya', last: 'Johnson' },
  { first: 'Ethan', last: 'Nguyen' },
  { first: 'Olivia', last: 'Martinez' },
  { first: 'Lucas', last: 'Brown' },
  { first: 'Emma', last: 'Wilson' },
  { first: 'Mateo', last: 'Garcia' },
  { first: 'Isabella', last: 'Lee' },
  { first: 'Gabriel', last: 'Thompson' },
  { first: 'Chloe', last: 'Anderson' },
  { first: 'Daniel', last: 'White' },
  { first: 'Zoe', last: 'Harris' },
  { first: 'Henry', last: 'Clark' },
  { first: 'Lily', last: 'Lewis' },
  { first: 'Jack', last: 'Robinson' },
  { first: 'Grace', last: 'Walker' },
  { first: 'Owen', last: 'Hall' },
  { first: 'Mia', last: 'Young' },
  { first: 'Samuel', last: 'King' },
  { first: 'Ella', last: 'Wright' },
  { first: 'Benjamin', last: 'Scott' },
  { first: 'Nora', last: 'Green' },
];

function memberProfile(n: number): { first: string; last: string } {
  const profile = SALES_DEMO_MEMBER_PROFILES[n - 1];
  if (!profile) {
    throw new Error(`No sales demo member profile for index ${n}`);
  }
  return profile;
}

export function salesDemoMemberId(n: number): string {
  return `sales-demo-member-${String(n).padStart(2, '0')}`;
}

export function salesDemoMemberEmail(n: number): string {
  const { first, last } = memberProfile(n);
  return `${first}.${last}@harborline.ai`.toLowerCase();
}

export function salesDemoMemberName(n: number): string {
  const { first, last } = memberProfile(n);
  return `${first} ${last}`;
}

export function salesDemoMemberAvatarUrl(email: string): string {
  const hash = createHash('md5').update(email.toLowerCase().trim()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=80&d=identicon`;
}

export function demoOrganizationSettings(now: Date) {
  return {
    enable_usage_limits: true,
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
    const name = salesDemoMemberName(n);
    const imageUrl = salesDemoMemberAvatarUrl(email);
    const padded = String(n).padStart(2, '0');
    await txn
      .insert(kilocode_users)
      .values({
        id,
        google_user_email: email,
        google_user_name: name,
        google_user_image_url: imageUrl,
        stripe_customer_id: `cus_sales_demo_${padded}`,
        normalized_email: email,
      })
      .onConflictDoUpdate({
        target: kilocode_users.id,
        set: {
          google_user_email: email,
          google_user_name: name,
          google_user_image_url: imageUrl,
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
    .onConflictDoNothing({
      target: [organizations.created_by_kilo_user_id],
      where: sql`(${organizations.settings}->>'is_sales_demo')::boolean = true AND ${organizations.deleted_at} IS NULL`,
    })
    .returning();

  if (!organization) {
    const winner = await findLiveSalesDemoOwnedBy(targetUser.id, txn);
    if (winner) {
      throw new Error(ALREADY_OWNS_DEMO, {
        cause: { organizationId: winner.id, organizationName: winner.name },
      });
    }
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

  await populateSalesDemoUsage(txn, {
    organization,
    actorUser: adminUser,
    memberIds: [...demoIds, targetUser.id],
    now,
  });

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

  // The deletes below destroy the org's usage and credit rows, so record the
  // discarded real spend first. `microdollars_used` includes seeded usage, so
  // subtract the seeded baseline before writing the ledger row.
  //
  // Before the seeded baseline existed this wrote the full `microdollars_used`
  // form (PR #5496). Remove the seeded subtraction once every live demo org
  // carries `sales_demo_seeded_microdollars`.
  const seeded = org.settings.sales_demo_seeded_microdollars ?? 0;
  const realSpend = Number(org.microdollars_used) - seeded;
  if (realSpend > 0) {
    await txn.insert(sales_demo_spend_ledger).values({
      organization_id: organizationId,
      owner_kilo_user_id: ownerId,
      period_start: org.settings.sales_demo_last_reset_at ?? org.created_at,
      microdollars_used: realSpend,
    });
  }

  await txn.execute(sql`
    DELETE FROM ${microdollar_usage_metadata}
    WHERE id IN (
      SELECT id FROM microdollar_usage WHERE organization_id = ${organizationId}
    )
  `);
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
  await txn
    .delete(organization_user_usage)
    .where(eq(organization_user_usage.organization_id, organizationId));
  await txn
    .delete(microdollar_usage_daily)
    .where(eq(microdollar_usage_daily.organization_id, organizationId));

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
    .where(eq(organization_memberships.organization_id, organizationId));

  await txn
    .delete(organization_user_limits)
    .where(eq(organization_user_limits.organization_id, organizationId));

  if (ownerId) {
    await addUserToOrganization(organizationId, ownerId, 'owner', txn);
  }

  for (const demoId of demoIds) {
    await addUserToOrganization(organizationId, demoId, 'member', txn);
  }

  const [reloadedOrg] = await txn
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!reloadedOrg) {
    throw new Error(`Organization ${organizationId} not found after reset`);
  }

  await populateSalesDemoUsage(txn, {
    organization: reloadedOrg,
    actorUser,
    memberIds: [...demoIds, ownerId].filter((id): id is string => Boolean(id)),
    now,
  });

  return organizationId;
}
