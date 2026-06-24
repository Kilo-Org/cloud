import type { Organization } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { baseProcedure } from '@/lib/trpc/init';
import type { TRPCContext } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray } from 'drizzle-orm';
import * as z from 'zod';

export const OrganizationIdInputSchema = z.object({
  organizationId: z.uuid(),
});

const parentOrganizationAccessRoles = ['owner', 'billing_manager'] satisfies OrganizationRole[];
const rolePriority = ['owner', 'billing_manager', 'member'] satisfies OrganizationRole[];

function allowedRole(
  rows: { role: OrganizationRole }[],
  roles?: OrganizationRole[]
): OrganizationRole | null {
  const allowedRoles = roles && roles.length > 0 ? roles : rolePriority;
  return (
    rolePriority.find(role => allowedRoles.includes(role) && rows.some(row => row.role === role)) ??
    null
  );
}

export async function ensureOrganizationAccess(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<OrganizationRole> {
  if (ctx.user.is_admin) {
    return 'owner';
  }
  const directRows = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, ctx.user.id),
        eq(organization_memberships.organization_id, organizationId)
      )
    );

  const inheritedRows = await db
    .select({ role: organization_memberships.role })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, organizations.parent_organization_id),
        eq(organization_memberships.kilo_user_id, ctx.user.id),
        inArray(organization_memberships.role, parentOrganizationAccessRoles)
      )
    )
    .where(eq(organizations.id, organizationId));

  const rows = [...directRows, ...inheritedRows];

  if (!rows.length) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have access to this organization',
    });
  }

  const role = allowedRole(rows, roles);
  if (!role) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }
  return role;
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

  const directRows = await db
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

  const inheritedRows = await db
    .select({
      role: organization_memberships.role,
      organization: organizations,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, organizations.parent_organization_id),
        eq(organization_memberships.kilo_user_id, ctx.user.id),
        inArray(organization_memberships.role, parentOrganizationAccessRoles)
      )
    )
    .where(eq(organizations.id, organizationId));

  const rows = [...directRows, ...inheritedRows];

  if (!rows.length) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have access to this organization',
    });
  }

  const role = allowedRole(rows, roles);
  if (!role) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }

  return rows.find(row => row.role === role)?.organization ?? rows[0].organization;
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

// Custom procedure that ensures user has owner access to the organization
export const organizationOwnerProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ['owner']);
    return next();
  });

// Owner procedure that also enforces trial/subscription status on mutations
export const organizationOwnerMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ['owner']);
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
