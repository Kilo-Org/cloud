import { organization_group_memberships, organization_groups } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { WorkerDb } from './pg';

export type GroupRow = typeof organization_groups.$inferSelect;
export type GroupMembershipRow = typeof organization_group_memberships.$inferSelect;

export async function listOrganizationGroups(
  db: WorkerDb,
  organizationId: string
): Promise<GroupRow[]> {
  return db
    .select()
    .from(organization_groups)
    .where(eq(organization_groups.organization_id, organizationId));
}

/**
 * Group assignments are the one join in this area with real referential
 * integrity: a composite foreign key on `(organization_id, kilo_user_id)`
 * points at `organization_memberships`, so an assignment cannot exist without
 * a membership and is cascaded away when the membership is deleted.
 */
export async function listGroupMemberships(
  db: WorkerDb,
  organizationId: string,
  groupId: string
): Promise<GroupMembershipRow[]> {
  return db
    .select()
    .from(organization_group_memberships)
    .where(
      and(
        eq(organization_group_memberships.organization_id, organizationId),
        eq(organization_group_memberships.group_id, groupId)
      )
    );
}

export async function listUserGroupMemberships(
  db: WorkerDb,
  organizationId: string,
  kiloUserId: string
): Promise<GroupMembershipRow[]> {
  return db
    .select()
    .from(organization_group_memberships)
    .where(
      and(
        eq(organization_group_memberships.organization_id, organizationId),
        eq(organization_group_memberships.kilo_user_id, kiloUserId)
      )
    );
}
