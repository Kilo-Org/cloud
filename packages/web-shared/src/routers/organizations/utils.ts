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
  type KiloAdminElevationReason,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import {
  findSupportAllowEntry,
  getSupportAccessMode,
  supportStandInRole,
  type OrganizationAccess,
  type SupportAccessMode,
  type SupportDecision,
  type SupportActionClass,
  type SupportContext,
  type SupportSurface,
} from '@kilocode/web-shared/lib/admin/support-access';
import {
  evaluateSupportAccess,
  isLiveOrganization,
  latestSupportGrantStatus,
} from '@kilocode/web-shared/lib/admin/support-access-resolver';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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
): Promise<{ role: OrganizationRole }[]> {
  const [directRows, inheritedRows] = await Promise.all([
    db
      .select({ role: organization_memberships.role })
      .from(organization_memberships)
      .innerJoin(
        organizations,
        activeOrganizationJoinCondition(organization_memberships.organization_id)
      )
      .where(
        and(
          eq(organization_memberships.kilo_user_id, userId),
          eq(organization_memberships.organization_id, organizationId)
        )
      ),
    db
      .select({ role: organization_memberships.role })
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
          eq(organization_memberships.kilo_user_id, userId),
          inArray(organization_memberships.role, ORGANIZATION_PARENT_ACCESS_ROLES)
        )
      )
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at))),
  ]);

  return [...directRows, ...inheritedRows];
}

export type OrganizationAccessContext = Pick<
  TRPCContext,
  | 'user'
  | 'authViaToken'
  | 'tokenSource'
  | 'credential'
  | 'internalApiUse'
  | 'ip'
  | 'headersList'
  | 'trpcPath'
  | 'trpcType'
> & {
  auditSurface?: 'trpc' | 'rest' | 'server-component';
  auditMethod?: string;
  delegatedWorkload?: boolean;
};

export type ResolveOrganizationAccessOptions = {
  roles?: OrganizationRole[];
  /**
   * Replaces the `is_admin: false` fake contexts: membership (direct or
   * inherited) is the only accepted authority.
   */
  member?: 'only';
  /** Exact REST route pattern or inventory key. Defaults to the tRPC path. */
  supportKey?: string | null;
  supportActionId?: string | null;
  surface?: SupportSurface;
  /** Required for a REST write; tRPC derives it from the procedure type. */
  requiredActionClass?: SupportActionClass;
  /** Telemetry reason for the elevation event. Defaults to the tRPC reason. */
  auditReason?: KiloAdminElevationReason;
  /** `ensureOrganizationAccessAndFetchOrg` attributes the attempt before the fetch. */
  skipOrganizationLiveness?: boolean;
};

function supportKeyFor(
  ctx: OrganizationAccessContext,
  options: ResolveOrganizationAccessOptions
): { surface: SupportSurface; key: string | null } {
  const surface = options.surface ?? (ctx.trpcPath === undefined ? 'rest' : 'trpc');
  const key = options.supportKey !== undefined ? options.supportKey : (ctx.trpcPath ?? null);
  return { surface, key };
}

function requiredActionClassFor(
  ctx: OrganizationAccessContext,
  options: ResolveOrganizationAccessOptions
): SupportActionClass {
  if (options.requiredActionClass) return options.requiredActionClass;
  return ctx.trpcType === 'mutation' ? 'support_write' : 'support_read';
}

function supportActionIdFor(
  ctx: OrganizationAccessContext,
  options: ResolveOrganizationAccessOptions,
  key: string | null
): string | null {
  if (options.supportActionId !== undefined) return options.supportActionId;
  if (ctx.trpcPath !== undefined) return `${ctx.trpcPath}:${ctx.trpcType ?? 'query'}`;
  return key;
}

function deniedAccessError(params: {
  memberOnly: boolean;
  decision: SupportDecision;
  grantStatus: 'expired' | 'revoked' | null;
}): TRPCError {
  if (params.memberOnly) {
    return new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have access to this organization',
    });
  }
  const cause = params.grantStatus
    ? `support_grant_${params.grantStatus}`
    : `support_access_${params.decision}`;
  return new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'Explicit support access is required for this organization',
    cause: { code: cause, decision: params.decision },
  });
}

/**
 * The single mode-aware decision point for organization access.
 *
 * - A real membership role always passes and never queries a grant.
 * - `off`/`observe` keep today's `is_admin` -> `owner` shortcut, recording the
 *   decision enforcement would have reached.
 * - `enforce` admits only `member` or an active, allowlisted `SupportContext`.
 */
export async function resolveOrganizationAccess(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  options: ResolveOrganizationAccessOptions = {}
): Promise<OrganizationAccess> {
  let rows: Awaited<ReturnType<typeof loadEffectiveMembershipRows>>;
  let membershipObserved = true;
  try {
    rows = await loadEffectiveMembershipRows(ctx.user.id, organizationId);
  } catch (membershipError) {
    // Elevation telemetry must never be the reason a request fails, and an
    // admin fallback still has to work when the membership read is unavailable.
    if (!ctx.user.is_admin) throw membershipError;
    membershipObserved = false;
    rows = [];
  }
  const role = allowedRole(rows, options.roles);
  if (role) {
    return { kind: 'member', role };
  }

  if (!options.skipOrganizationLiveness && !(await isLiveOrganization(organizationId))) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  }

  if (options.member === 'only') {
    throw deniedAccessError({
      memberOnly: true,
      decision: 'deny_actor_permission',
      grantStatus: null,
    });
  }

  const isAdmin = ctx.user.is_admin;
  if (!isAdmin) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have access to this organization',
    });
  }

  const { surface, key } = supportKeyFor(ctx, options);
  const supportActionId = supportActionIdFor(ctx, options, key);
  const evaluation = await evaluateSupportAccess({
    actorKiloUserId: ctx.user.id,
    organizationId,
    requiredActionClass: requiredActionClassFor(ctx, options),
    roles: options.roles,
    surface,
    key,
    supportActionId,
  });
  const mode: SupportAccessMode = getSupportAccessMode();
  const membershipRole = membershipObserved ? allowedRole(rows) : null;
  const wouldPassWithoutAdmin = membershipObserved ? role !== null : null;
  const elevationReason = options.auditReason ?? 'organization_access';

  if (mode === 'enforce') {
    if (evaluation.access) {
      await recordKiloAdminElevation(ctx, {
        reason: elevationReason,
        target: organizationTarget(organizationId),
        membershipRole,
        wouldPassWithoutAdmin,
        supportDecision: evaluation.decision,
        supportGrantId: evaluation.grantId,
        supportActionId,
        inventoryId: evaluation.access.inventoryId,
      });
      return evaluation.access;
    }
    const grantStatus =
      evaluation.decision === 'deny_no_grant'
        ? await latestSupportGrantStatus({
            actorKiloUserId: ctx.user.id,
            organizationId,
          })
        : null;
    await recordKiloAdminElevation(ctx, {
      reason: elevationReason,
      target: organizationTarget(organizationId),
      membershipRole,
      wouldPassWithoutAdmin,
      supportDecision: evaluation.decision,
      supportGrantId: evaluation.grantId,
      supportActionId,
      inventoryId: null,
    });
    throw deniedAccessError({
      memberOnly: false,
      decision: evaluation.decision,
      grantStatus,
    });
  }

  await recordKiloAdminElevation(ctx, {
    reason: elevationReason,
    target: organizationTarget(organizationId),
    membershipRole,
    wouldPassWithoutAdmin,
    supportDecision: evaluation.decision,
    supportGrantId: evaluation.grantId,
    supportActionId,
    inventoryId: null,
  });
  return { kind: 'legacy_admin', role: 'owner', wouldBe: evaluation.decision };
}

/**
 * Returns a role for the caller, admitting a support grant only when the exact
 * procedure is on the allowlist. Use this instead of `ensureOrganizationAccess`
 * on allowlisted reads and writes.
 */
export async function ensureOrganizationAccessOrSupport(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<{ access: OrganizationAccess; role: OrganizationRole }> {
  const access = await resolveOrganizationAccess(ctx, organizationId, { roles });
  if (access.kind === 'support') {
    const { surface, key } = supportKeyFor(ctx, { roles });
    const entry = key
      ? findSupportAllowEntry({ surface, key, actionClass: access.actionClass })
      : undefined;
    if (!entry) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Explicit support access is required for this organization',
      });
    }
    return { access, role: supportStandInRole(entry) };
  }
  return { access, role: access.role };
}

export async function ensureOrganizationAccess(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<OrganizationRole> {
  const access = await resolveOrganizationAccess(ctx, organizationId, { roles });
  if (access.kind === 'member') return access.role;
  if (access.kind === 'legacy_admin') return access.role;
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'You do not have the required organizational role to access this feature',
  });
}

/**
 * Resolves the caller's effective role for each of `organizationIds` in a fixed
 * number of queries (vs one per org). Mirrors {@link ensureOrganizationAccess}:
 * admins get 'owner' everywhere, otherwise direct memberships are unioned with
 * roles inherited from a parent org (owner/billing_manager). Orgs the caller has
 * no access to are simply absent from the returned map.
 */
async function loadBatchMembershipRoles(
  userId: string,
  organizationIds: Organization['id'][]
): Promise<Map<string, OrganizationRole[]>> {
  const directRows = await db
    .select({
      organizationId: organization_memberships.organization_id,
      role: organization_memberships.role,
    })
    .from(organization_memberships)
    .innerJoin(
      organizations,
      activeOrganizationJoinCondition(organization_memberships.organization_id)
    )
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        inArray(organization_memberships.organization_id, organizationIds)
      )
    );

  const inheritedRows = await db
    .select({
      organizationId: organizations.id,
      role: organization_memberships.role,
    })
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
        eq(organization_memberships.kilo_user_id, userId),
        inArray(organization_memberships.role, ORGANIZATION_PARENT_ACCESS_ROLES)
      )
    )
    .where(and(inArray(organizations.id, organizationIds), isNull(organizations.deleted_at)));

  const rolesByOrg = new Map<string, OrganizationRole[]>();
  for (const row of [...directRows, ...inheritedRows]) {
    const list = rolesByOrg.get(row.organizationId) ?? [];
    list.push(row.role);
    rolesByOrg.set(row.organizationId, list);
  }
  return rolesByOrg;
}

export async function getOrganizationsAccessRoles(
  ctx: TRPCContext,
  organizationIds: Organization['id'][]
): Promise<Map<string, OrganizationRole>> {
  const uniqueIds = Array.from(new Set(organizationIds));
  const result = new Map<string, OrganizationRole>();
  if (uniqueIds.length === 0) {
    return result;
  }
  if (getSupportAccessMode() === 'enforce') {
    const rolesByOrg = await loadBatchMembershipRoles(ctx.user.id, uniqueIds);
    for (const [organizationId, roles] of rolesByOrg) {
      const best = rolePriority.find(role => roles.includes(role));
      if (best) result.set(organizationId, best);
    }
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
      observeBatchMembershipRoles(() => loadBatchMembershipRoles(ctx.user.id, uniqueIds)),
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
      wouldPassWithoutAdmin: rolesByOrg === null ? null : liveIds.every(id => rolesByOrg.has(id)),
    });
    for (const id of liveIds) result.set(id, grant);
    return result;
  }

  const rolesByOrg = await loadBatchMembershipRoles(ctx.user.id, uniqueIds);
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
  const accessByOrg = await getOrganizationsAccessRoles(ctx, organizationIds);
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
  try {
    await resolveOrganizationAccess(ctx, organizationId, {
      roles,
      auditReason: 'organization_fetch',
      skipOrganizationLiveness: true,
    });
  } catch (accessError) {
    if (accessError instanceof TRPCError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    throw accessError;
  }
  const [organization] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  if (!organization) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  }
  return organization;
}

// Custom procedure that ensures user has access to the organization (any role)
export const organizationMemberProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    try {
      const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId);
      if (process.env.NODE_ENV === 'development') {
        console.log('[organizationMemberProcedure] Access granted, calling next');
      }
      return next({ ctx: { organizationAccess } });
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
    const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId);
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next({ ctx: { organizationAccess } });
  });

// Ensures the caller can manage the organization (owner or admin).
export const organizationAdminProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId, {
      roles: ORGANIZATION_MANAGE_ROLES,
    });
    return next({ ctx: { organizationAccess } });
  });

// Owner/admin procedure that also enforces trial/subscription status on mutations
export const organizationAdminMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId, {
      roles: ORGANIZATION_MANAGE_ROLES,
    });
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next({ ctx: { organizationAccess } });
  });

// Custom procedure that ensures user has owner or billing_manager access to the organization
export const organizationBillingProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId, {
      roles: ORGANIZATION_BILLING_ROLES,
    });
    return next({ ctx: { organizationAccess } });
  });

// Owner or billing_manager procedure that also enforces trial/subscription status on mutations
export const organizationBillingMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId, {
      roles: ORGANIZATION_BILLING_ROLES,
    });
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next({ ctx: { organizationAccess } });
  });
