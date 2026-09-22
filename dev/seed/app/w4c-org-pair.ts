/**
 * Seed fixture for the W4C member-revocation E2E scenario (S4).
 *
 * Creates one organization with an owner and a member, both of whom must
 * already exist (created via `app:create-user`). Used to test that removing a
 * member closes their socket.
 *
 * Idempotent: deletes this fixture's previously created organization for the
 * given owner before recreating one pair, so reruns never accumulate the
 * repeated org rows the app lists. The organization carries the user-facing
 * name the app renders (`SEEDED_ORGANIZATION_NAME`) and a fixture-specific id
 * derived from the owner email, so cleanup targets that exact row. The cleanup
 * also matches the rows this fixture wrote before the name became user-facing,
 * which carry the stable `[seed:w4c-org-pair] <owner-email>` name. Neither
 * branch keys on a display name an ordinary organization could share.
 *
 * Usage: pnpm dev:seed app:w4c-org-pair <owner-email> <member-email>
 */

import {
  kiloclaw_instances,
  kilocode_users,
  organizations,
  organization_memberships,
  organization_seats_purchases,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, inArray, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { w4cOrgPairCleanupPredicate, w4cOrgPairOrganizationId } from '../lib/w4c-org-pair-fixture';
import type { SeedResult } from '../index';

export const usage = '<owner-email> <member-email>';

/**
 * The name the app shows for this fixture's organization.
 *
 * The mobile account sheet renders an organization's name verbatim, so the
 * name must stay user-facing and never carry a `[seed:...]` developer marker.
 */
export const SEEDED_ORGANIZATION_NAME = 'Acme Corp';

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
 * Selects this fixture's previously created organization for one owner so
 * reruns stay idempotent. It matches two fixture-specific values only:
 *
 * - the deterministic id `w4cOrgPairOrganizationId` derives from the owner
 *   email, the row this fixture writes now;
 * - the legacy `[seed:w4c-org-pair] <owner-email>` name, which the fixture
 *   wrote before the display name became user-facing.
 *
 * Neither branch selects on the user-facing display name, so an ordinary
 * organization owned by the same user is never deleted.
 */
export function w4cOrgPairCleanupCondition(ownerEmail: string) {
  return or(
    eq(organizations.id, w4cOrgPairOrganizationId(ownerEmail)),
    w4cOrgPairCleanupPredicate(ownerEmail)
  );
}

/** Deletes the organizations `w4cOrgPairCleanupCondition` selects for one owner. */
async function cleanupPreviousOrgs(ownerEmail: string): Promise<void> {
  const db = getSeedDb();

  const previousOrgs = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(w4cOrgPairCleanupCondition(ownerEmail));

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

  const organizationId = w4cOrgPairOrganizationId(trimmedOwnerEmail);

  await db.insert(organizations).values({
    id: organizationId,
    name: SEEDED_ORGANIZATION_NAME,
    created_by_kilo_user_id: ownerUserId,
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
