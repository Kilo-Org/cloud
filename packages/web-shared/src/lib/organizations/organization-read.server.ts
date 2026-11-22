import 'server-only';

import { organizations, type Organization } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { type db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';

/**
 * Read the live organization row.
 *
 * Callers that already loaded and authorized the row pass it in, so the policy
 * reflects the same organization the request authorized instead of a second read
 * that could disagree with it. A soft-deleted organization fails closed.
 */
export async function readLiveOrganization(
  client: typeof db | DrizzleTransaction,
  params: { organizationId: string; organization?: Organization }
): Promise<Organization> {
  if (params.organization) {
    if (params.organization.deleted_at) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    return params.organization;
  }
  const [organization] = await client
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, params.organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  return organization;
}
