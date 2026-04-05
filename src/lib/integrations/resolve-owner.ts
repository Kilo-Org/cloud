import { z } from 'zod';
import type { Owner } from './core/types';
import type { TRPCContext } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { OrganizationRole } from '@/lib/organizations/organization-types';

/** Shared zod schema for endpoints that optionally accept an organizationId. */
export const optionalOrgInput = z
  .object({ organizationId: z.string().uuid().optional() })
  .optional();

/**
 * Build an Owner value from the request context.
 *
 * **Important:** this function does NOT perform any authorization check.
 * Callers should use {@link resolveAuthorizedOwner} instead, which validates
 * org membership before constructing the owner, or call
 * {@link ensureIntegrationAccess} explicitly before this function.
 */
export function resolveOwner(ctx: TRPCContext, organizationId?: string): Owner {
  return organizationId ? { type: 'org', id: organizationId } : { type: 'user', id: ctx.user.id };
}

export async function ensureIntegrationAccess(
  ctx: TRPCContext,
  organizationId?: string,
  roles?: OrganizationRole[]
) {
  if (organizationId) {
    await ensureOrganizationAccess(ctx, organizationId, roles ?? ['owner', 'billing_manager']);
  }
}

/**
 * Validates org membership (when applicable) and returns the resolved Owner.
 * Combines {@link ensureIntegrationAccess} + {@link resolveOwner} in a single call
 * so callers cannot forget the access check.
 */
export async function resolveAuthorizedOwner(
  ctx: TRPCContext,
  organizationId?: string,
  roles?: OrganizationRole[]
): Promise<Owner> {
  await ensureIntegrationAccess(ctx, organizationId, roles);
  return resolveOwner(ctx, organizationId);
}
