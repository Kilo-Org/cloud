import { getWorkerDb } from '@kilocode/db/client';
import { organization_memberships } from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/db/schema-types';
import { eq, ne, and } from 'drizzle-orm';

export type OrgMembership = {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
};

/**
 * Verify that a user is a member of an organization.
 * Queries organization_memberships via Hyperdrive.
 * Returns the membership record or null if not a member.
 */
export async function verifyOrgMembership(
  env: Env,
  orgId: string,
  userId: string
): Promise<OrgMembership | null> {
  if (!env.HYPERDRIVE) throw new Error('HYPERDRIVE binding not configured');
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
  const rows = await db
    .select({
      role: organization_memberships.role,
    })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, orgId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);

  if (rows.length === 0) return null;
  return {
    organizationId: orgId,
    userId,
    role: rows[0].role,
  };
}

/**
 * List all organization IDs that a user belongs to (excluding billing_manager).
 * Used by ownership verification to find org-owned resources.
 */
export async function listUserOrgIds(env: Env, userId: string): Promise<string[]> {
  if (!env.HYPERDRIVE) throw new Error('HYPERDRIVE binding not configured');
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 5_000 });
  const rows = await db
    .select({
      organizationId: organization_memberships.organization_id,
    })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        ne(organization_memberships.role, 'billing_manager')
      )
    );

  return rows.map(r => r.organizationId);
}
