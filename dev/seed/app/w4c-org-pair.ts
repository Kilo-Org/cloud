/**
 * Seed fixture for the W4C member-revocation E2E scenario (S4).
 *
 * Creates one organization with an owner and a member, both of whom must
 * already exist (created via `app:create-user`). Used to test that removing a
 * member closes their socket.
 *
 * Idempotent: deletes this fixture's previously created organizations for the
 * given owner (stable `[seed:w4c-org-pair] <owner-email>` name) before
 * recreating one pair.
 *
 * Usage: pnpm dev:seed app:w4c-org-pair <owner-email> <member-email>
 */

import { randomUUID } from 'node:crypto';

import {
  kiloclaw_instances,
  kilocode_users,
  organizations,
  organization_memberships,
  organization_seats_purchases,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { w4cOrgPairCleanupPredicate, w4cOrgPairName } from '../lib/w4c-org-pair-fixture';
import type { SeedResult } from '../index';

export const usage = '<owner-email> <member-email>';

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:w4c-org-pair ${usage}`);
  console.log('');
  console.log('Creates one organization with an owner and a member. Both users must');
  console.log('already exist (create them first with app:create-user).');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm dev:seed app:w4c-org-pair owner@example.com member@example.com');
}

async function lookupUserId(email: string): Promise<string> {
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);

  const rows = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(eq(kilocode_users.normalized_email, normalizedEmail))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`No user with email ${email} exists. Create it first with app:create-user.`);
  }

  return rows[0].id;
}

/**
 * Deletes this fixture's previously created organizations for one owner so
 * reruns stay idempotent. The owner email is the stable key (the member email
 * changes between harness runs) and the org name embeds it, so scoping the
 * predicate to that owner avoids accumulating one identically named org per
 * run without deleting fixture orgs seeded for a different owner.
 */
async function cleanupPreviousOrgs(ownerEmail: string): Promise<void> {
  const db = getSeedDb();

  const previousOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(w4cOrgPairCleanupPredicate(ownerEmail));

  const orgIds = previousOrgs.map(org => org.id);
  if (orgIds.length === 0) {
    return;
  }

  await db.delete(kiloclaw_instances).where(inArray(kiloclaw_instances.organization_id, orgIds));
  await db
    .delete(organization_seats_purchases)
    .where(inArray(organization_seats_purchases.organization_id, orgIds));
  await db
    .delete(platform_integrations)
    .where(inArray(platform_integrations.owned_by_organization_id, orgIds));
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, orgIds));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const [ownerEmail, memberEmail, ...rest] = args;
  if (!ownerEmail || !memberEmail) {
    printUsage();
    throw new Error('owner-email and member-email are required');
  }
  if (rest.length > 0) {
    printUsage();
    throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  }

  const db = getSeedDb();
  const trimmedOwnerEmail = ownerEmail.trim();
  const trimmedMemberEmail = memberEmail.trim();

  const ownerUserId = await lookupUserId(trimmedOwnerEmail);
  const memberUserId = await lookupUserId(trimmedMemberEmail);

  if (ownerUserId === memberUserId) {
    throw new Error('owner-email and member-email must refer to different users');
  }

  await cleanupPreviousOrgs(trimmedOwnerEmail);

  const organizationId = randomUUID();

  await db.insert(organizations).values({
    id: organizationId,
    name: w4cOrgPairName(trimmedOwnerEmail),
  });

  await db.insert(organization_memberships).values([
    {
      organization_id: organizationId,
      kilo_user_id: ownerUserId,
      role: 'owner',
    },
    {
      organization_id: organizationId,
      kilo_user_id: memberUserId,
      role: 'member',
    },
  ]);

  return {
    organizationId,
    ownerUserId,
    memberUserId,
  };
}
