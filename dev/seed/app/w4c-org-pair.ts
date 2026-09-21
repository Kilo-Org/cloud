/**
 * Seed fixture for the W4C member-revocation E2E scenario (S4).
 *
 * Creates one organization with an owner and a member, both of whom must
 * already exist (created via `app:create-user`). Used to test that removing a
 * member closes their socket.
 *
 * The fixture is idempotent: rerunning it for the same pair keeps the oldest
 * organization it created before, so the mobile account sheet lists one row
 * per account instead of one row per seed run.
 *
 * Usage: pnpm dev:seed app:w4c-org-pair <owner-email> <member-email>
 */

import { randomUUID } from 'node:crypto';

import { kilocode_users, organizations, organization_memberships } from '@kilocode/db/schema';
import { eq, inArray, like, or, sql } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  FIXTURE_SETTINGS_KEY,
  FIXTURE_SETTINGS_VALUE,
  fixtureSettingsMarkerJson,
  LEGACY_ORGANIZATION_NAME_PREFIX,
  membershipsToPrune,
  SEEDED_ORGANIZATION_NAME,
  selectSeededOrganization,
} from '../lib/w4c-org-pair';
import type { SeedResult } from '../index';

export const usage = '<owner-email> <member-email>';

/**
 * The name the app shows for this fixture's organization.
 *
 * The mobile account sheet renders an organization's name verbatim, so the
 * name must stay user-facing and never carry a `[seed:...]` developer marker.
 */
export { SEEDED_ORGANIZATION_NAME };

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:w4c-org-pair ${usage}`);
  console.log('');
  console.log('Creates one organization with an owner and a member. Both users must');
  console.log('already exist (create them first with app:create-user).');
  console.log('');
  console.log('Rerunning with the same pair reuses the organization created before, so');
  console.log('the fixture stays one organization per pair.');
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
 * Every organization this fixture has ever created, whatever name it carried:
 * the settings marker, the legacy `[seed:w4c-org-pair] ` prefix, or the name
 * written since #6332.
 */
async function listFixtureOrganizations() {
  const db = getSeedDb();
  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      created_at: organizations.created_at,
      settings: organizations.settings,
    })
    .from(organizations)
    .where(
      or(
        eq(organizations.name, SEEDED_ORGANIZATION_NAME),
        like(organizations.name, `${LEGACY_ORGANIZATION_NAME_PREFIX}%`),
        sql`${organizations.settings} ->> ${FIXTURE_SETTINGS_KEY} = ${FIXTURE_SETTINGS_VALUE}`
      )
    );
}

/** The two users' memberships, with the joined organization's name/settings. */
async function listMemberships(userIds: readonly string[]) {
  const db = getSeedDb();
  return db
    .select({
      id: organization_memberships.id,
      organization_id: organization_memberships.organization_id,
      kilo_user_id: organization_memberships.kilo_user_id,
      organizationName: organizations.name,
      organizationSettings: organizations.settings,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(inArray(organization_memberships.kilo_user_id, userIds));
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

  const userIds = [ownerUserId, memberUserId];

  // Recognition is database-wide on purpose: the settings marker is a plain
  // flag (`w4c_org_pair: 'true'`), so it cannot identify which pair a row came
  // from. The fixture therefore converges on the oldest organization it ever
  // created and prunes only this pair's memberships elsewhere, so each of the
  // two users ends with exactly one fixture organization membership and the
  // account sheet lists that organization once.
  const fixtureOrganizations = await listFixtureOrganizations();
  const keptOrganization = selectSeededOrganization(fixtureOrganizations);
  const organizationId = keptOrganization?.id ?? randomUUID();

  if (!keptOrganization) {
    await db.insert(organizations).values({
      id: organizationId,
      name: SEEDED_ORGANIZATION_NAME,
    });
  }

  // Merge the marker into `settings` without dropping the other keys, and drop
  // the legacy `[seed:w4c-org-pair] ` name so the app shows a user-facing name.
  const renamesFromLegacyMarker =
    keptOrganization !== undefined &&
    keptOrganization.name.startsWith(LEGACY_ORGANIZATION_NAME_PREFIX);
  await db
    .update(organizations)
    .set({
      settings: sql`${organizations.settings} || ${fixtureSettingsMarkerJson()}::jsonb`,
      ...(renamesFromLegacyMarker ? { name: SEEDED_ORGANIZATION_NAME } : {}),
    })
    .where(eq(organizations.id, organizationId));

  // The pair must end up with exactly one membership each: the kept
  // organization's. Membership rows in the other fixture organizations are
  // pruned; the organizations themselves are never deleted.
  const membershipRows = await listMemberships(userIds);
  const pruneMembershipIds = membershipsToPrune(membershipRows, organizationId, userIds).map(
    row => row.id
  );
  if (pruneMembershipIds.length > 0) {
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.id, pruneMembershipIds));
  }

  await db
    .insert(organization_memberships)
    .values([
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
    ])
    .onConflictDoUpdate({
      target: [organization_memberships.organization_id, organization_memberships.kilo_user_id],
      set: { role: sql`excluded.role` },
    });

  return {
    organizationId,
    ownerUserId,
    memberUserId,
    prunedMembershipCount: pruneMembershipIds.length,
  };
}
