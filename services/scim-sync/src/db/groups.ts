import { organization_group_memberships, organization_groups } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import type { WorkerDb } from './pg';

/**
 * Kilo's own permission groups, which are **not** WorkOS directory groups
 * despite the shared word.
 *
 * An `organization_groups` row is a named set of capability policies — `read`,
 * `edit`, `browser`, `command`, `mcp` — scoped to one organization
 * (`OrganizationGroupPolicies` in `packages/db/src/schema-types.ts:1466-1480`).
 * A group membership assigns a user those capabilities inside that
 * organization. Nothing here is populated by directory sync today: a WorkOS
 * directory group binds to an *organization* through
 * `organizations.directory_group_id`, not to a row in this table.
 *
 * They are read here because a reconciler has to see the authorization state it
 * might disturb: deleting a membership cascades these assignments away, so the
 * capabilities a user holds are a consequence of membership changes even though
 * no directory event names them.
 */

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
