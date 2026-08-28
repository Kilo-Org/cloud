/**
 * Seed fixture for the parent-organization "sub-organizations" People tab.
 *
 * Creates one parent organization, two direct child organizations, and a
 * roster of users covering the membership shapes that surface's directory,
 * drawer, and bulk wizards each need to be exercised against:
 *
 *   - Olivia (parent owner)         — no direct child memberships, so her
 *     ability to manage every child comes entirely from inherited access.
 *   - Adam (parent admin)           — also a direct member of Child A, so
 *     both the inherited-access path and a direct row are visible for him.
 *   - Bianca (parent billing_manager) — can invite/add members but can't
 *     edit roles; useful for the permission-boundary case.
 *   - Marco (parent member)         — plain member, read-only everywhere.
 *   - Priya (parent member, Child A owner) — an elevated *child* role, to
 *     exercise the "never silently strip an owner/billing_manager child
 *     membership" guard in setChildMemberships.
 *   - Mateo (parent member, Child A member) — a normal existing cross-org
 *     member, to exercise "add to additional sub-organizations" (Child B).
 *   - Chloe (Child B member only, NOT a parent member) — exercises the
 *     "must be a member of the parent organization first" exclusion in the
 *     add-people wizard.
 *   - A pending invitation into Child B for an email with no account yet.
 *
 * Idempotent: deletes all orgs/users/invitations matching the seed prefix
 * before recreating.
 *
 * Usage: pnpm dev:seed app:sub-organizations
 */

import { randomUUID } from 'node:crypto';

import {
  kilocode_users,
  organizations,
  organization_memberships,
  organization_invitations,
  organization_membership_removals,
} from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/db/schema-types';
import { ilike, inArray } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

const ORG_PREFIX = '[seed:sub-orgs]';
const EMAIL_PREFIX = 'dev-seed-suborgs-';
const USER_EMAIL_PATTERN = `${EMAIL_PREFIX}%@example.com`;
const PENDING_INVITE_EMAIL = `${EMAIL_PREFIX}sam-pending@example.com`;

function printUsage(): void {
  console.log('Usage: pnpm dev:seed app:sub-organizations');
  console.log('');
  console.log(
    'Creates one parent organization, two direct child organizations, and a\n' +
      'roster of users covering the membership shapes the sub-organizations\n' +
      'People tab, drawer, and bulk wizards need. No arguments.'
  );
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
  const db = getSeedDb();

  const seedOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(ilike(organizations.name, `${ORG_PREFIX}%`));
  const orgIds = seedOrgs.map(org => org.id);

  if (orgIds.length > 0) {
    await db
      .delete(organization_invitations)
      .where(inArray(organization_invitations.organization_id, orgIds));
    await db
      .delete(organization_membership_removals)
      .where(inArray(organization_membership_removals.organization_id, orgIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, orgIds));
    // Children first: parent_organization_id has ON DELETE RESTRICT.
    await db.delete(organizations).where(inArray(organizations.parent_organization_id, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }

  const seedUsers = await db
    .select({ id: kilocode_users.id, stripeCustomerId: kilocode_users.stripe_customer_id })
    .from(kilocode_users)
    .where(ilike(kilocode_users.google_user_email, USER_EMAIL_PATTERN));

  for (const user of seedUsers) {
    if (user.stripeCustomerId) {
      await deleteSeedStripeCustomer(user.stripeCustomerId);
    }
  }
  if (seedUsers.length > 0) {
    await db.delete(kilocode_users).where(
      inArray(
        kilocode_users.id,
        seedUsers.map(user => user.id)
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

// `stripe_customer_id` is NOT NULL, so — per dev/seed/AGENTS.md, "Direct user
// inserts" — this creates a real Stripe test-mode customer per user rather
// than a fake `cus_seed_...` placeholder: these users get signed into via
// fake login to click around the app, and a fake id would 400 the first
// time any Stripe-touching code path (e.g. /profile) looks it up. Requires
// STRIPE_SECRET_KEY (test mode) to be configured; run `vercel env pull` if
// this fails with a missing/invalid key error.
async function createUser(handle: string, name: string): Promise<{ id: string; email: string }> {
  const db = getSeedDb();
  const id = randomUUID();
  const email = `${EMAIL_PREFIX}${handle}@example.com`;
  const stripeCustomer = await createSeedStripeCustomer({ email, name, kiloUserId: id });
  try {
    await db.insert(kilocode_users).values({
      id,
      google_user_email: email,
      google_user_name: name,
      google_user_image_url: `https://example.com/${id}.png`,
      stripe_customer_id: stripeCustomer.id,
      normalized_email: normalizeSeedEmail(email),
      has_validation_stytch: true,
      customer_source: 'dev-seed',
    } satisfies typeof kilocode_users.$inferInsert);
  } catch (error) {
    await deleteSeedStripeCustomer(stripeCustomer.id);
    throw error;
  }
  return { id, email };
}

async function createOrg(name: string, parentOrganizationId?: string): Promise<string> {
  const db = getSeedDb();
  const id = randomUUID();
  await db.insert(organizations).values({
    id,
    name: `${ORG_PREFIX} ${name}`,
    plan: 'teams',
    require_seats: false,
    parent_organization_id: parentOrganizationId ?? null,
  } satisfies typeof organizations.$inferInsert);
  return id;
}

async function addMember(organizationId: string, kiloUserId: string, role: OrganizationRole) {
  const db = getSeedDb();
  await db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: kiloUserId,
    role,
  } satisfies typeof organization_memberships.$inferInsert);
}

async function addPendingInvitation(
  organizationId: string,
  email: string,
  invitedBy: string,
  role: OrganizationRole
) {
  const db = getSeedDb();
  await db.insert(organization_invitations).values({
    organization_id: organizationId,
    email,
    role,
    invited_by: invitedBy,
    token: randomUUID(),
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  } satisfies typeof organization_invitations.$inferInsert);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  if (args.length > 0) {
    printUsage();
    throw new Error(`Unexpected arguments: ${args.join(' ')}`);
  }

  console.log('Cleaning up existing seed data...');
  await cleanup();

  console.log('Creating users...');
  const olivia = await createUser('owner', 'Olivia Owner');
  const adam = await createUser('admin', 'Adam Admin');
  const bianca = await createUser('billing', 'Bianca Billing');
  const marco = await createUser('member', 'Marco Member');
  const priya = await createUser('childowner', 'Priya ChildOwner');
  const mateo = await createUser('multichild', 'Mateo MultiChild');
  const chloe = await createUser('childonly', 'Chloe ChildOnly');

  console.log('Creating parent organization...');
  const parentId = await createOrg('Acme HQ');
  await addMember(parentId, olivia.id, 'owner');
  await addMember(parentId, adam.id, 'admin');
  await addMember(parentId, bianca.id, 'billing_manager');
  await addMember(parentId, marco.id, 'member');
  await addMember(parentId, priya.id, 'member');
  await addMember(parentId, mateo.id, 'member');

  console.log('Creating child organizations...');
  const childSalesId = await createOrg('Acme Sales', parentId);
  await addMember(childSalesId, adam.id, 'member');
  await addMember(childSalesId, priya.id, 'owner');
  await addMember(childSalesId, mateo.id, 'member');

  const childEngineeringId = await createOrg('Acme Engineering', parentId);
  await addMember(childEngineeringId, chloe.id, 'member');
  await addPendingInvitation(childEngineeringId, PENDING_INVITE_EMAIL, olivia.id, 'member');

  console.log(`
This fixture represents:
  Acme HQ (parent)
    owner:           ${olivia.email}
    admin:           ${adam.email}  (also a direct member of Acme Sales)
    billing_manager: ${bianca.email}
    member:          ${marco.email}
    member:          ${priya.email}  (owner of Acme Sales — elevated child role)
    member:          ${mateo.email}  (also a member of Acme Sales)
  Acme Sales (child)
    member: ${adam.email}, owner: ${priya.email}, member: ${mateo.email}
  Acme Engineering (child)
    member:  ${chloe.email}  (not a member of Acme HQ — the parent)
    pending: ${PENDING_INVITE_EMAIL}

Note: Chloe is deliberately NOT a parent member, to exercise the "must be a
member of the parent organization first" exclusion in the add-people wizard.
Priya's Acme Sales "owner" role exercises the guard that keeps
setChildMemberships from ever silently removing an elevated child role.

Suggested next step: sign in as the parent owner and open the People tab.
  http://localhost:<port>/users/sign_in?fakeUser=${olivia.email}&callbackPath=/organizations/${parentId}/sub-organizations
Swap fakeUser for any email above to see the same page from that role's view.
`);

  return {
    parentOrganizationId: parentId,
    childSalesOrganizationId: childSalesId,
    childEngineeringOrganizationId: childEngineeringId,
    ownerEmail: olivia.email,
    adminEmail: adam.email,
    billingManagerEmail: bianca.email,
    memberEmail: marco.email,
    childOwnerEmail: priya.email,
    multiChildMemberEmail: mateo.email,
    childOnlyMemberEmail: chloe.email,
    pendingInviteEmail: PENDING_INVITE_EMAIL,
  };
}
