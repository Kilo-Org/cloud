import type { WorkerDb } from '@kilocode/db/client';
import { organization_memberships } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';

export type SecurityNotificationOwner =
  | { organizationId: string; userId?: never }
  | { userId: string; organizationId?: never };

export function isOrganizationNotificationOwner(
  owner: SecurityNotificationOwner
): owner is { organizationId: string; userId?: never } {
  return 'organizationId' in owner && Boolean(owner.organizationId);
}

export async function resolveNotificationRecipientUserIds(
  db: WorkerDb,
  owner: SecurityNotificationOwner
): Promise<string[]> {
  if (!isOrganizationNotificationOwner(owner)) return [owner.userId];

  const rows = await db
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, owner.organizationId),
        eq(organization_memberships.role, 'owner')
      )
    );

  return [...new Set(rows.map(row => row.userId))];
}
