import { randomUUID } from 'node:crypto';

import {
  auto_top_up_configs,
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';

export const usage = '<owner-email> <admin-email> <member-email>';

/**
 * One enterprise organization and one teams organization, with the three roles
 * the organization screens gate on:
 *
 * - the enterprise organization has Kilo Encrypt on, three seats, auto top-up
 *   enabled with a $50 amount at a $10 threshold, a seat purchase row and a few
 *   audit entries. It is inside its trial, so nothing is refused.
 * - the teams organization has two seats and no auto top-up, and only the owner
 *   is a member, so the plan-only rows (enterprise model access, SSO, audit
 *   logs, groups) are absent beside it.
 *
 * The seat purchase names a Stripe subscription that does not exist, because
 * the local stack runs with `SKIP_STRIPE_API=true`: `subscription.get` reads it,
 * fails the provider lookup inside its own try/catch, and answers with no
 * subscription — the billing screen's empty state — while the purchase row
 * still proves the read and its status. No Stripe call is made by this seed.
 */
const ENTERPRISE_ORGANIZATION_ID = 'a4f1c2d3-0000-4000-8000-9a1b2c3d4e01';
const TEAMS_ORGANIZATION_ID = 'a4f1c2d3-0000-4000-8000-9a1b2c3d4e02';

const SEAT_PURCHASE_ID = 'a4f1c2d3-0000-4000-8000-9a1b2c3d4e10';

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-org-admin ${usage}`);
  console.log(
    'Seeds an enterprise organization with owner/admin/member memberships and a teams organization.'
  );
  console.log('Requires a localhost database and SKIP_STRIPE_API=true; never calls a provider.');
  console.log('Open the returned deep links in the signed-in mobile development client.');
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const [ownerEmail, adminEmail, memberEmail, ...extra] = args;
  const fakeEmail = /^kilo-[a-z0-9-]+@example\.com$/;
  if (
    !ownerEmail ||
    !adminEmail ||
    !memberEmail ||
    extra.length ||
    ![ownerEmail, adminEmail, memberEmail].every(email => fakeEmail.test(email))
  ) {
    printUsage();
    throw new Error('Pass three distinct fake emails: owner, admin and member.');
  }
  if (new Set([ownerEmail, adminEmail, memberEmail]).size !== 3) {
    throw new Error('Pass three distinct fake emails: owner, admin and member.');
  }
  assertLocalSeedDatabase('app:mobile-org-admin');
  if (process.env.NODE_ENV === 'production' || process.env.SKIP_STRIPE_API !== 'true') {
    throw new Error('This fixture requires a local development database and SKIP_STRIPE_API=true.');
  }

  const db = getSeedDb();
  const members = [
    { email: ownerEmail, name: 'Org admin lab owner', role: 'owner' as const },
    { email: adminEmail, name: 'Org admin lab admin', role: 'admin' as const },
    { email: memberEmail, name: 'Org admin lab member', role: 'member' as const },
  ];

  const userIds: Record<string, string> = {};
  for (const member of members) {
    const userId = `dev-seed:mobile-org-admin:${member.email}`;
    const [existing] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.normalized_email, member.email));
    if (existing && existing.id !== userId) {
      throw new Error(`${member.email} belongs to a different account; choose a new fake email.`);
    }
    await db
      .insert(kilocode_users)
      .values({
        id: userId,
        google_user_email: member.email,
        normalized_email: member.email,
        google_user_name: member.name,
        google_user_image_url: '',
        stripe_customer_id: `cus_local_org_admin_${randomUUID()}`,
        has_validation_stytch: true,
        customer_source: 'dev-seed',
      })
      .onConflictDoNothing();
    userIds[member.role] = userId;
  }

  await db
    .insert(organizations)
    .values({
      id: ENTERPRISE_ORGANIZATION_ID,
      name: 'Org admin lab enterprise',
      created_by_kilo_user_id: userIds.owner,
      stripe_customer_id: `cus_local_org_admin_${randomUUID()}`,
      free_trial_end_at: daysFromNow(10),
      require_seats: true,
      seat_count: 3,
      plan: 'enterprise',
      auto_top_up_enabled: true,
      settings: { kilo_encrypt: true },
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: {
        free_trial_end_at: daysFromNow(10),
        seat_count: 3,
        auto_top_up_enabled: true,
        settings: { kilo_encrypt: true },
      },
    });

  await db
    .insert(organizations)
    .values({
      id: TEAMS_ORGANIZATION_ID,
      name: 'Org admin lab teams',
      created_by_kilo_user_id: userIds.owner,
      stripe_customer_id: `cus_local_org_admin_${randomUUID()}`,
      free_trial_end_at: daysFromNow(10),
      require_seats: true,
      seat_count: 2,
      plan: 'teams',
      auto_top_up_enabled: false,
      settings: {},
    })
    .onConflictDoUpdate({
      target: organizations.id,
      set: { free_trial_end_at: daysFromNow(10), seat_count: 2 },
    });

  for (const member of members) {
    await db
      .insert(organization_memberships)
      .values({
        organization_id: ENTERPRISE_ORGANIZATION_ID,
        kilo_user_id: userIds[member.role],
        role: member.role,
      })
      .onConflictDoNothing();
  }
  await db
    .insert(organization_memberships)
    .values({
      organization_id: TEAMS_ORGANIZATION_ID,
      kilo_user_id: userIds.owner,
      role: 'owner',
    })
    .onConflictDoNothing();

  await db
    .insert(auto_top_up_configs)
    .values({
      owned_by_organization_id: ENTERPRISE_ORGANIZATION_ID,
      created_by_user_id: userIds.owner,
      stripe_payment_method_id: `pm_local_org_admin_${randomUUID()}`,
      amount_cents: 5000,
      threshold_cents: 1000,
    })
    .onConflictDoNothing();

  await db
    .insert(organization_seats_purchases)
    .values({
      id: SEAT_PURCHASE_ID,
      organization_id: ENTERPRISE_ORGANIZATION_ID,
      subscription_stripe_id: `sub_local_org_admin_${randomUUID()}`,
      seat_count: 3,
      amount_usd: 150,
      starts_at: daysFromNow(-30),
      expires_at: daysFromNow(30),
      subscription_status: 'active',
      billing_cycle: 'monthly',
    })
    .onConflictDoNothing();

  const auditRows = [
    {
      action: 'organization.settings.change' as const,
      message: 'Organization settings updated',
      actor_email: ownerEmail,
      actor_name: 'Org admin lab owner',
    },
    {
      action: 'organization.user.send_invite' as const,
      message: `Invitation sent to ${memberEmail}`,
      actor_email: ownerEmail,
      actor_name: 'Org admin lab owner',
    },
    {
      action: 'organization.member.change_role' as const,
      message: `${adminEmail} was made an admin`,
      actor_email: ownerEmail,
      actor_name: 'Org admin lab owner',
    },
  ];
  for (const [index, row] of auditRows.entries()) {
    await db
      .insert(organization_audit_logs)
      .values({
        id: `a4f1c2d3-0000-4000-8000-9a1b2c3d4e2${index}`,
        organization_id: ENTERPRISE_ORGANIZATION_ID,
        actor_id: userIds.owner,
        actor_email: row.actor_email,
        actor_name: row.actor_name,
        action: row.action,
        message: row.message,
      })
      .onConflictDoNothing();
  }

  console.log(
    'This fixture represents: an enterprise organization with three roles and one seats purchase.'
  );
  console.log(
    'No subscription resolves locally (SKIP_STRIPE_API), so its billing state is the empty one.'
  );
  console.log('Suggested next step: open a returned deep link in the signed-in mobile app.');
  return {
    ownerUserId: userIds.owner,
    adminUserId: userIds.admin,
    memberUserId: userIds.member,
    ownerEmail,
    adminEmail,
    memberEmail,
    enterpriseOrganizationId: ENTERPRISE_ORGANIZATION_ID,
    teamsOrganizationId: TEAMS_ORGANIZATION_ID,
    enterpriseHubDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/${ENTERPRISE_ORGANIZATION_ID}`,
    enterpriseBillingDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/billing`,
    enterpriseAuditLogDeepLink: `kiloapp:///(app)/(tabs)/(3_profile)/organization/audit-log`,
    seatsPurchaseId: SEAT_PURCHASE_ID,
  };
}
