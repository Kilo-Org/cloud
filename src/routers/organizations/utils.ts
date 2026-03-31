import type { Organization } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { baseProcedure } from '@/lib/trpc/init';
import type { TRPCContext } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod';

export const OrganizationIdInputSchema = z.object({
  organizationId: z.uuid(),
});

export async function ensureOrganizationAccess(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<OrganizationRole> {
  if (ctx.user.is_admin) {
    return 'owner';
  }
  // if roles are provided, check if the user has one of those roles
  const rows = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, ctx.user.id),
        eq(organization_memberships.organization_id, organizationId)
      )
    );

  if (!rows.length) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have access to this organization',
    });
  }

  if (roles && roles.length > 0 && !rows.some(row => roles.includes(row.role))) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }
  return rows[0].role;
}

export async function ensureOrganizationAccessAndFetchOrg(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<Organization> {
  if (ctx.user.is_admin) {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));

    if (!org) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    return org;
  }

  // Check membership and fetch organization in a single query
  const rows = await db
    .select({
      role: organization_memberships.role,
      organization: organizations,
    })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.kilo_user_id, ctx.user.id),
        eq(organization_memberships.organization_id, organizationId)
      )
    );

  if (!rows.length) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have access to this organization',
    });
  }

  if (roles && roles.length > 0 && !rows.some(row => roles.includes(row.role))) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }

  return rows[0].organization;
}

// Custom procedure that ensures user has access to the organization (any role)
export const organizationMemberProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    try {
      await ensureOrganizationAccess(ctx, input.organizationId);
      if (process.env.NODE_ENV === 'development') {
        console.log('[organizationMemberProcedure] Access granted, calling next');
      }
      return next();
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.error('[organizationMemberProcedure] Error in middleware', {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorCode: error instanceof TRPCError ? error.code : 'unknown',
          errorStack: error instanceof Error ? error.stack : undefined,
        });
      }
      throw error;
    }
  });

// Member procedure that also enforces trial/subscription status on mutations
export const organizationMemberMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId);
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next();
  });

// Custom procedure that ensures user has owner or billing_manager access to the organization
export const organizationBillingProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'billing_manager']);
    return next();
  });

// Owner or billing_manager procedure that also enforces trial/subscription status on mutations
export const organizationBillingMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'billing_manager']);
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next();
  });
