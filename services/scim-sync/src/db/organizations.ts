import { organizations } from '@kilocode/db/schema';
import { and, count, eq, isNull } from 'drizzle-orm';

import type { WorkerDb } from './pg';

/**
 * The WorkOS directory hierarchy maps onto the organization hierarchy:
 *
 * | WorkOS | Kilo | Binding |
 * |---|---|---|
 * | directory | parent organization | `directory_id` |
 * | directory group | **sub-organization** | `directory_group_id`, `directory_idp_id` |
 * | group membership | membership on that sub-organization | — |
 *
 * The binding columns live on every `organizations` row, parent or child, which
 * is what makes a sub-organization the thing a directory group resolves to.
 * Kilo's `organization_groups` table is unrelated: it holds capability policy
 * sets and is not populated by directory sync.
 */

export type OrganizationRow = typeof organizations.$inferSelect;

/**
 * Every query here filters `deleted_at IS NULL`.
 *
 * That is not cosmetic. The unique indexes on `directory_group_id` and
 * `external_org_id` are partial, scoped to live rows, so a soft-deleted
 * organization can hold the same binding as a live one. Dropping the filter
 * makes those lookups non-deterministic.
 */
const isLive = isNull(organizations.deleted_at);

export async function findOrganizationById(
  db: WorkerDb,
  organizationId: string
): Promise<OrganizationRow | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isLive))
    .limit(1);
  return rows.at(0) ?? null;
}

/**
 * Resolve the sub-organization a directory group is bound to. This is the
 * central lookup for a `dsync.group.*` event.
 */
export async function findOrganizationByDirectoryGroupId(
  db: WorkerDb,
  directoryGroupId: string
): Promise<OrganizationRow | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.directory_group_id, directoryGroupId), isLive))
    .limit(1);
  return rows.at(0) ?? null;
}

/**
 * Resolve by identity-provider group ID, which survives a directory
 * disconnect/reconnect that mints a new `directory_group_id`.
 *
 * Returns every match rather than one: this index is deliberately non-unique,
 * because a reconnect can leave two live sub-organizations briefly sharing an
 * IdP group while the new `directory_group_id` is adopted.
 */
export async function findOrganizationsByDirectoryIdpId(
  db: WorkerDb,
  directoryIdpId: string
): Promise<OrganizationRow[]> {
  return db
    .select()
    .from(organizations)
    .where(and(eq(organizations.directory_idp_id, directoryIdpId), isLive));
}

/** The organization's identifier in the customer's own system. */
export async function findOrganizationByExternalOrgId(
  db: WorkerDb,
  externalOrgId: string
): Promise<OrganizationRow | null> {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.external_org_id, externalOrgId), isLive))
    .limit(1);
  return rows.at(0) ?? null;
}

/**
 * The sub-organizations under a parent — which is also the set of directory
 * groups bound to that directory, since a directory group maps to a
 * sub-organization.
 *
 * The hierarchy is one level deep (a child cannot itself be a parent), so this
 * is the whole subtree rather than just the first layer. Depth is enforced in
 * application code, not by the schema.
 */
export async function findChildOrganizations(
  db: WorkerDb,
  parentOrganizationId: string
): Promise<OrganizationRow[]> {
  return db
    .select()
    .from(organizations)
    .where(and(eq(organizations.parent_organization_id, parentOrganizationId), isLive));
}

/** Reachability probe. Counts in SQL rather than materializing every row. */
export async function countOrganizations(db: WorkerDb): Promise<number> {
  const rows = await db.select({ total: count() }).from(organizations).where(isLive);
  return rows.at(0)?.total ?? 0;
}
