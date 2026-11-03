import { organizations } from '@kilocode/db/schema';
import { and, count, eq, isNull } from 'drizzle-orm';

import type { WorkerDb } from './pg';

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

/** The primary WorkOS binding: the directory group backing an organization. */
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
 * The identity-provider group ID, which survives a directory
 * disconnect/reconnect that mints a new `directory_group_id`.
 *
 * Returns every match rather than one: this index is deliberately non-unique,
 * because one IdP group can map to two live organizations during a reconnect.
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
 * Direct children of an organization. The hierarchy is one level deep — a
 * child cannot itself be a parent — so this is the whole subtree, not just the
 * first layer. Depth is enforced in application code, not by the schema.
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
