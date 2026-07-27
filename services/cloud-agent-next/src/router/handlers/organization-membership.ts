import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import { organization_memberships } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

export async function assertOrganizationMembership(
  db: WorkerDb,
  userId: string,
  organizationId: string
): Promise<void> {
  const [membership] = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have access to this organization',
    });
  }
}
