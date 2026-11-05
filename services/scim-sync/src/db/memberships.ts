import { organization_membership_removals, organization_memberships } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { WorkerDb } from './pg';

export type MembershipRow = typeof organization_memberships.$inferSelect;
export type MembershipRemovalRow = typeof organization_membership_removals.$inferSelect;

/**
 * `organization_memberships` declares no foreign keys on either
 * `organization_id` or `kilo_user_id`, so a row here does not prove the
 * organization or the user exists, and neither is cleaned up when the other
 * side goes away. Callers that need the referenced row must look it up.
 *
 * `(organization_id, kilo_user_id)` is unique, so this returns at most one row.
 */
export async function findMembership(
  db: WorkerDb,
  organizationId: string,
  kiloUserId: string
): Promise<MembershipRow | null> {
  const rows = await db
    .select()
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, kiloUserId)
      )
    )
    .limit(1);
  return rows.at(0) ?? null;
}

export async function listOrganizationMemberships(
  db: WorkerDb,
  organizationId: string
): Promise<MembershipRow[]> {
  return db
    .select()
    .from(organization_memberships)
    .where(eq(organization_memberships.organization_id, organizationId));
}

export async function listUserMemberships(
  db: WorkerDb,
  kiloUserId: string
): Promise<MembershipRow[]> {
  return db
    .select()
    .from(organization_memberships)
    .where(eq(organization_memberships.kilo_user_id, kiloUserId));
}

/**
 * Removal tombstone. A removed membership is hard-deleted and a row is written
 * here instead, so the absence of a membership plus the presence of a tombstone
 * is what distinguishes "deliberately removed" from "never joined". A tombstone
 * is not cleared when the user rejoins, so its presence does not imply the
 * membership is currently absent — check both.
 */
export async function findMembershipRemoval(
  db: WorkerDb,
  organizationId: string,
  kiloUserId: string
): Promise<MembershipRemovalRow | null> {
  const rows = await db
    .select()
    .from(organization_membership_removals)
    .where(
      and(
        eq(organization_membership_removals.organization_id, organizationId),
        eq(organization_membership_removals.kilo_user_id, kiloUserId)
      )
    )
    .limit(1);
  return rows.at(0) ?? null;
}
