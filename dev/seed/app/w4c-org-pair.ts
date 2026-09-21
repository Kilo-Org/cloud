/**
 * Seed fixture for the W4C member-revocation E2E scenario (S4).
 *
 * Creates one organization with an owner and a member, both of whom must
 * already exist (created via `app:create-user`). Used to test that removing a
 * member closes their socket.
 *
 * Idempotent: deletes this fixture's previously created organizations for the
 * given owner before recreating one pair, so reruns never accumulate the
 * repeated org rows the app lists. The organization carries the user-facing
 * name the app renders (`SEEDED_ORGANIZATION_NAME`), and the cleanup scopes to
 * the owner through the `role: 'owner'` membership the fixture always writes,
 * so it also finds the rows a seed run before this one wrote without a creator
 * (`created_by_kilo_user_id` is nullable with no default). Rows seeded before
 * the name became user-facing carry the stable
 * `[seed:w4c-org-pair] <owner-email>` marker instead.
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
import { and, eq, inArray, or } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import { w4cOrgPairCleanupPredicate } from '../lib/w4c-org-pair-fixture';
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
 * Selects this fixture's previously created organizations for one owner so
 * reruns stay idempotent. The owner is the stable key (the member email
 * changes between harness runs), and the selection is scoped to that owner
 * through the `role: 'owner'` membership the fixture always writes, so fixture
 * orgs seeded for a different owner survive and this user appearing there as a
 * plain member never selects them.
 *
 * The creator column cannot scope the rows this fixture wrote before this
 * change: that seed inserted `{ id, name }` only, and
 * `organizations.created_by_kilo_user_id` is a nullable column with no
 * default, so every such row has a NULL creator and the owner membership is the
 * only owner signal those rows carry.
 *
 * - rows named with the stable `[seed:w4c-org-pair] <owner-email>` marker,
 *   which this fixture inserted before the display name became user-facing;
 * - rows carrying the current user-facing display name.
 *
 * Must be used with an inner join on `organization_memberships`.
 */
export function w4cOrgPairCleanupCondition(ownerEmail: string, ownerUserId: string) {
  return and(
    eq(organization_memberships.kilo_user_id, ownerUserId),
    eq(organization_memberships.role, 'owner'),
    or(w4cOrgPairCleanupPredicate(ownerEmail), eq(organizations.name, SEEDED_ORGANIZATION_NAME))
  );
}

/** Deletes the organizations `w4cOrgPairCleanupCondition` selects for one owner. */
async function cleanupPreviousOrgs(ownerEmail: string, ownerUserId: string): Promise<void> {
  const db = getSeedDb();

  const previousOrgs = await db
    .selectDistinct({ id: organizations.id })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(w4cOrgPairCleanupCondition(ownerEmail, ownerUserId));

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

  await cleanupPreviousOrgs(trimmedOwnerEmail, ownerUserId);

  const organizationId = randomUUID();

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
