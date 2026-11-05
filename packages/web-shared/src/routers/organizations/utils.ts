import type { Organization } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
  ORGANIZATION_PARENT_ACCESS_ROLES,
} from '@kilocode/app-shared/organizations';
import { baseProcedure } from '@kilocode/web-shared/lib/trpc/init';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import {
  elevateViaKiloAdmin,
  organizationTarget,
  organizationsTarget,
  recordKiloAdminElevation,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn, type SelectedFields } from 'drizzle-orm/pg-core';
import * as z from 'zod';
import { activeOrganizationJoinCondition } from '@kilocode/worker-utils/organization-membership';

const parentOrganizations = alias(organizations, 'parent_organizations');

export const OrganizationIdInputSchema = z.object({
  organizationId: z.uuid(),
});

/**
 * A soft-deleted organization is reported as missing rather than as an
 * authorization failure. Existing callers rely on NOT_FOUND for an
 * organization that no longer exists, while a live organization the caller
 * cannot access stays UNAUTHORIZED.
 */
async function isSoftDeletedOrganization(organizationId: Organization['id']): Promise<boolean> {
  const [organization] = await db
    .select({ deletedAt: organizations.deleted_at })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return organization?.deletedAt != null;
}

/** Matches the caller's organizations by id, used by {@link selectCallerRoleRows}. */
type OrganizationIdFilter = (column: AnyPgColumn) => SQL;

const callerRoleFields = {
  role: organization_memberships.role,
  organizationId: organizations.id,
} as const;

const callerRoleWithOrganizationFields = {
  ...callerRoleFields,
  organization: organizations,
} as const;

type CallerRoleRow = {
  role: OrganizationRole;
  organizationId: Organization['id'];
};

type CallerRoleRowWithOrganization = CallerRoleRow & { organization: Organization };

/**
 * The caller's membership roles in the organizations matched by
 * `organizationFilter`: a direct membership in a live organization, plus the
 * roles inherited from a live parent organization. The membership,
 * live-organization and inheritable-role rules live only here, so the role
 * check and the organization fetch cannot drift.
 *
 * The selection is a compile-time argument: Drizzle cannot build its query
 * types from a generic selection, so the overloads declare the projection and
 * the implementation takes the selection loosely. The organization overload
 * comes first because a wider object is assignable to the narrower one.
 */
async function selectCallerRoleRows(
  kiloUserId: string,
  organizationFilter: OrganizationIdFilter,
  fields: typeof callerRoleWithOrganizationFields
): Promise<CallerRoleRowWithOrganization[]>;
async function selectCallerRoleRows(
  kiloUserId: string,
  organizationFilter: OrganizationIdFilter,
  fields: typeof callerRoleFields
): Promise<CallerRoleRow[]>;
async function selectCallerRoleRows(
  kiloUserId: string,
  organizationFilter: OrganizationIdFilter,
  fields: SelectedFields
): Promise<unknown[]> {
  const [directRows, inheritedRows] = await Promise.all([
    db
      .select(fields)
      .from(organization_memberships)
      .innerJoin(
        organizations,
        activeOrganizationJoinCondition(organization_memberships.organization_id)
      )
      .where(
        and(
          eq(organization_memberships.kilo_user_id, kiloUserId),
          organizationFilter(organization_memberships.organization_id)
        )
      ),
    db
      .select(fields)
      .from(organizations)
      .innerJoin(
        parentOrganizations,
        and(
          eq(parentOrganizations.id, organizations.parent_organization_id),
          isNull(parentOrganizations.deleted_at)
        )
      )
      .innerJoin(
        organization_memberships,
        and(
          eq(organization_memberships.organization_id, organizations.parent_organization_id),
          eq(organization_memberships.kilo_user_id, kiloUserId),
          inArray(organization_memberships.role, ORGANIZATION_PARENT_ACCESS_ROLES)
        )
      )
      .where(and(organizationFilter(organizations.id), isNull(organizations.deleted_at))),
  ]);

  return [...directRows, ...inheritedRows];
}

const rolePriority = ['owner', 'admin', 'billing_manager', 'member'] satisfies OrganizationRole[];

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

export function settle<T>(
  promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  );
}

export async function observeMembershipRole(
  loader: () => Promise<{ role: OrganizationRole }[]>,
  roles?: OrganizationRole[]
): Promise<{
  membershipRole: OrganizationRole | null;
  wouldPassWithoutAdmin: boolean | null;
}> {
  try {
    const rows = await loader();
    return {
      membershipRole: allowedRole(rows),
      wouldPassWithoutAdmin: allowedRole(rows, roles) !== null,
    };
  } catch {
    return { membershipRole: null, wouldPassWithoutAdmin: null };
  }
}

async function observeBatchMembershipRoles(
  loader: () => Promise<Map<string, OrganizationRole[]>>
): Promise<Map<string, OrganizationRole[]> | null> {
  try {
    return await loader();
  } catch {
    return null;
  }
}

export async function loadEffectiveMembershipRows(
  userId: string,
  organizationId: Organization['id']
): Promise<CallerRoleRow[]> {
  return selectCallerRoleRows(userId, column => eq(column, organizationId), callerRoleFields);
}

export async function ensureOrganizationAccess(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<OrganizationRole> {
  if (ctx.user.is_admin) {
    // An admin elevation applies only to an organization that exists and is
    // live, matching getOrganizationById. A rejected request is not recorded
    // as an elevation.
    const organizationResult = settle(
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
        .limit(1)
    );
    const observation = await observeMembershipRole(
      () => loadEffectiveMembershipRows(ctx.user.id, organizationId),
      roles
    );
    const rowsResult = await organizationResult;
    if (!rowsResult.ok) {
      await recordKiloAdminElevation(ctx, {
        reason: 'organization_access',
        target: organizationTarget(organizationId),
        ...observation,
      });
      throw rowsResult.error;
    }
    if (!rowsResult.value[0]) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }
    await recordKiloAdminElevation(ctx, {
      reason: 'organization_access',
      target: organizationTarget(organizationId),
      ...observation,
    });
    return 'owner';
  }
  const rows = await selectCallerRoleRows(
    ctx.user.id,
    column => eq(column, organizationId),
    callerRoleFields
  );

  if (!rows.length) {
    if (await isSoftDeletedOrganization(organizationId)) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }
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

/**
 * Resolves the caller's effective role for each of `organizationIds` in a fixed
 * number of queries (vs one per org). Mirrors {@link ensureOrganizationAccess}:
 * admins get 'owner' everywhere, otherwise direct memberships are unioned with
 * roles inherited from a parent org (owner/billing_manager). Orgs the caller has
 * no access to are simply absent from the returned map.
 */
function groupRolesByOrganization(rows: CallerRoleRow[]): Map<string, OrganizationRole[]> {
  const rolesByOrg = new Map<string, OrganizationRole[]>();
  for (const row of rows) {
    const list = rolesByOrg.get(row.organizationId) ?? [];
    list.push(row.role);
    rolesByOrg.set(row.organizationId, list);
  }
  return rolesByOrg;
}

export async function getOrganizationsAccessRoles(
  ctx: TRPCContext,
  organizationIds: Organization['id'][],
  roles?: OrganizationRole[]
): Promise<Map<string, OrganizationRole>> {
  const uniqueIds = Array.from(new Set(organizationIds));
  const result = new Map<string, OrganizationRole>();
  if (uniqueIds.length === 0) {
    return result;
  }
  if (ctx.user.is_admin) {
    // Only organizations that exist and are live are elevated, matching
    // getOrganizationById.
    const [liveOrgRows, rolesByOrg] = await Promise.all([
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(inArray(organizations.id, uniqueIds), isNull(organizations.deleted_at))),
      observeBatchMembershipRoles(async () =>
        groupRolesByOrganization(
          await selectCallerRoleRows(
            ctx.user.id,
            column => inArray(column, uniqueIds),
            callerRoleFields
          )
        )
      ),
    ]);
    const liveIds = liveOrgRows.map(row => row.id);
    if (liveIds.length === 0) {
      return result;
    }
    const grant = await elevateViaKiloAdmin(ctx, {
      reason: 'organization_access_batch',
      target: organizationsTarget(liveIds),
      grant: 'owner',
      membershipRole: null,
      wouldPassWithoutAdmin:
        rolesByOrg === null
          ? null
          : liveIds.every(
              id =>
                allowedRole(
                  (rolesByOrg.get(id) ?? []).map(role => ({ role })),
                  roles
                ) !== null
            ),
    });
    for (const id of liveIds) result.set(id, grant);
    return result;
  }

  const rolesByOrg = groupRolesByOrganization(
    await selectCallerRoleRows(ctx.user.id, column => inArray(column, uniqueIds), callerRoleFields)
  );
  for (const [organizationId, roles] of rolesByOrg) {
    const best = rolePriority.find(role => roles.includes(role));
    if (best) result.set(organizationId, best);
  }
  return result;
}

/**
 * Batched variant of {@link ensureOrganizationAccess} for many orgs at once.
 * Throws unless the caller has an allowed role on *every* org in the list.
 */
export async function ensureOrganizationsAccess(
  ctx: TRPCContext,
  organizationIds: Organization['id'][],
  roles?: OrganizationRole[]
): Promise<void> {
  const accessByOrg = await getOrganizationsAccessRoles(ctx, organizationIds, roles);
  const allowedRoles = roles && roles.length > 0 ? roles : rolePriority;
  for (const organizationId of new Set(organizationIds)) {
    const role = accessByOrg.get(organizationId);
    if (!role || !allowedRoles.includes(role)) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
    }
  }
}

export async function ensureOrganizationAccessAndFetchOrg(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<Organization> {
  if (ctx.user.is_admin) {
    const organizationResult = settle(
      db
        .select()
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    );
    const observation = await observeMembershipRole(
      () => loadEffectiveMembershipRows(ctx.user.id, organizationId),
      roles
    );
    await recordKiloAdminElevation(ctx, {
      reason: 'organization_fetch',
      target: organizationTarget(organizationId),
      ...observation,
    });
    const rowsResult = await organizationResult;
    if (!rowsResult.ok) throw rowsResult.error;
    const [org] = rowsResult.value;
    if (!org) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    return org;
  }

  const rows = await selectCallerRoleRows(
    ctx.user.id,
    column => eq(column, organizationId),
    callerRoleWithOrganizationFields
  );

  if (!rows.length) {
    if (await isSoftDeletedOrganization(organizationId)) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }
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

// Ensures the caller can manage the organization (owner or admin).
export const organizationAdminProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
    return next();
  });

// Owner/admin procedure that also enforces trial/subscription status on mutations
export const organizationAdminMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next();
  });

// Custom procedure that ensures user has owner or billing_manager access to the organization
export const organizationBillingProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_BILLING_ROLES);
    return next();
  });

// Owner or billing_manager procedure that also enforces trial/subscription status on mutations
export const organizationBillingMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_BILLING_ROLES);
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next();
  });
