import type { EnvironmentOwner } from '@kilocode/cloud-agent-profile';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { TRPCError } from '@trpc/server';

export function getOwner(organizationId: string | undefined, userId: string): EnvironmentOwner {
  return organizationId
    ? { type: 'organization', id: organizationId }
    : { type: 'user', id: userId };
}

export async function requireActiveOrganization(organizationId: string): Promise<void> {
  if (!(await getOrganizationById(organizationId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
}
