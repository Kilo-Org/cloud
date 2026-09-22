/**
 * Seed fixture for the W4C member-revocation E2E scenario (S4).
 *
 * Creates one organization with an owner and a member, both of whom must
 * already exist (created via `app:create-user`). Used to test that removing a
 * member closes their socket.
 *
 * Usage: pnpm dev:seed app:w4c-org-pair <owner-email> <member-email>
 */

import { randomUUID } from 'node:crypto';

import { kilocode_users, organizations, organization_memberships } from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import type { SeedResult } from '../index';

export const usage = '<owner-email> <member-email>';

/**
 * The name the app shows for this fixture's organization.
 *
 * The mobile account sheet renders an organization's name verbatim, so the
 * name must stay user-facing and never carry a `[seed:...]` developer marker.
 */
export const SEEDED_ORGANIZATION_NAME = 'Acme Corp';

/**
 * The developer marker an earlier revision of this fixture put in the
 * organization name. A rerun still recognizes those rows, so the duplicates
 * they accumulated disappear instead of staying in the account sheet forever.
 */
export const SEEDED_ORGANIZATION_LEGACY_PREFIX = '[seed:w4c-org-pair]';

export type SeededOrganizationRow = {
  id: string;
  name: string;
  createdByUserId: string | null;
};

/**
 * Whether an organization is one this fixture created for `ownerUserId`.
 *
 * The account sheet lists an organization per row, so one organization per
 * seeding round makes the same row repeat for every round that reseeded the
 * pair (an explorer capture showed it about thirteen times). A rerun removes
 * the fixture's own organizations first, which keeps the pair at one row.
 *
 * Legacy recognition is by the stable `[seed:w4c-org-pair]` name prefix. The
 * current name is generic, so a row with it counts only as this owner's own:
 * the reset never looks outside the organizations `ownerUserId` holds the
 * `owner` role in, and inside them the fixture's row carries the fixture's
 * creator.
 *
 * This fixture only started recording `created_by_kilo_user_id` alongside the
 * reset, and the app's own create always fills the column
 * (`apps/web/src/lib/organizations/organizations.ts`), so a null creator on
 * this owner's row is an earlier run of the fixture and must be replaced too.
 */
export function isSeededOrganization(
  row: Pick<SeededOrganizationRow, 'name' | 'createdByUserId'>,
  ownerUserId: string
): boolean {
  if (row.name.startsWith(SEEDED_ORGANIZATION_LEGACY_PREFIX)) {
    return true;
  }
  if (row.name !== SEEDED_ORGANIZATION_NAME) {
    return false;
  }
  return row.createdByUserId === null || row.createdByUserId === ownerUserId;
}

/** The fixture's own organizations out of the ones `ownerUserId` owns. */
export function selectSeededOrganizations(
  rows: readonly SeededOrganizationRow[],
  ownerUserId: string
): SeededOrganizationRow[] {
  return rows.filter(row => isSeededOrganization(row, ownerUserId));
}

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
 * Delete the fixture's own organizations for `ownerUserId` and return how many
 * were removed. Scoped to organizations this owner holds the `owner` role in,
 * so rerunning one pair never reaches another account's organization.
 */
async function resetSeededOrganizations(ownerUserId: string): Promise<number> {
  const db = getSeedDb();

  const owned = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      createdByUserId: organizations.created_by_kilo_user_id,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .where(
      and(
        eq(organization_memberships.kilo_user_id, ownerUserId),
        eq(organization_memberships.role, 'owner'),
        isNull(organizations.deleted_at)
      )
    );

  const seeded = selectSeededOrganizations(owned, ownerUserId);
  if (seeded.length === 0) {
    return 0;
  }

  const organizationIds = seeded.map(organization => organization.id);
  // `organization_memberships.organization_id` carries no cascade.
  await db
    .delete(organization_memberships)
    .where(inArray(organization_memberships.organization_id, organizationIds));
  await db.delete(organizations).where(inArray(organizations.id, organizationIds));

  return organizationIds.length;
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

  const replaced = await resetSeededOrganizations(ownerUserId);

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

  if (replaced > 0) {
    console.log(
      `Note: replaced ${replaced} organization(s) this fixture created in an earlier run, so the account sheet lists this pair once.`
    );
  }

  return {
    organizationId,
    ownerUserId,
    memberUserId,
  };
}
