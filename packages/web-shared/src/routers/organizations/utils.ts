import type { Organization } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { supportStepUpPort } from '@kilocode/web-shared/lib/admin/support-step-up';
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
  isSupportAccessEnabled,
  supportStandInRole,
  type OrganizationAccess,
  type SupportDecision,
  type SupportActionClass,
  type SupportContext,
  type SupportSurface,
} from '@kilocode/web-shared/lib/admin/support-access';
import {
  evaluateSupportAccess,
  isLiveOrganization,
  latestSupportGrantStatus,
  organizationState,
  recordSupportWriteUse,
} from '@kilocode/web-shared/lib/admin/support-access-resolver';
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn, type SelectedFields } from 'drizzle-orm/pg-core';
import * as z from 'zod';
import { activeOrganizationJoinCondition } from '@kilocode/worker-utils/organization-membership';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

const parentOrganizations = alias(organizations, 'parent_organizations');
const warnSupportLookupFailure = sentryLogger('support_access_lookup', 'error');

export const OrganizationIdInputSchema = z.object({
  organizationId: z.uuid(),
});

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

export function effectiveMembershipRole(
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
      membershipRole: effectiveMembershipRole(rows),
      wouldPassWithoutAdmin: effectiveMembershipRole(rows, roles) !== null,
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

export async function loadEffectiveMembershipRowsWithOrganization(
  userId: string,
  organizationId: Organization['id']
): Promise<{ role: OrganizationRole; organization: Organization }[]> {
  const [directRows, inheritedRows] = await Promise.all([
    db
      .select({ role: organization_memberships.role, organization: organizations })
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
      .select({ role: organization_memberships.role, organization: organizations })
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
  | 'webSessionId'
> & {
  auditSurface?: 'trpc' | 'rest' | 'server-component';
  auditMethod?: string;
  delegatedWorkload?: boolean;
};

export type ResolveOrganizationAccessOptions = {
  roles?: OrganizationRole[];
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
  /** Reuse a membership read the caller already performed. */
  membershipRows?: { role: OrganizationRole }[];
  /** Reuse a liveness check the caller already performed. */
  organizationIsLive?: boolean;
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

type SupportAccessReason =
  | 'support_grant_required'
  | 'support_grant_expired'
  | 'support_grant_revoked'
  | 'support_access_not_allowlisted'
  | 'support_access_action_class'
  | 'support_grant_lookup_failed';

function supportAccessReasonFor(params: {
  decision: SupportDecision | null;
  grantStatus: 'expired' | 'revoked' | null;
}): SupportAccessReason {
  if (params.grantStatus === 'expired') return 'support_grant_expired';
  if (params.grantStatus === 'revoked') return 'support_grant_revoked';
  if (params.decision === 'deny_not_allowlisted' || params.decision === 'deny_never_list') {
    return 'support_access_not_allowlisted';
  }
  if (params.decision === 'deny_action_class') return 'support_access_action_class';
  return 'support_grant_required';
}

function supportLookupFailedError(): TRPCError {
  warnSupportLookupFailure('Support grant lookup failed; denying access');
  return new TRPCError({
    code: 'FORBIDDEN',
    message: 'Support access could not be verified; retry the request',
    cause: { supportAccessReason: 'support_grant_lookup_failed' },
  });
}

function deniedAccessError(params: {
  decision: SupportDecision | null;
  grantStatus: 'expired' | 'revoked' | null;
}): TRPCError {
  return new TRPCError({
    code: 'FORBIDDEN',
    message: 'Explicit support access is required for this organization',
    cause: {
      supportAccessReason: supportAccessReasonFor({
        decision: params.decision,
        grantStatus: params.grantStatus,
      }),
    },
  });
}

/**
 * The single support-access decision point for organization access.
 *
 * - A real membership role always passes and never queries a grant.
 * - OFF keeps today's `is_admin` -> `owner` shortcut.
 * - ON admits only `member` or an active, allowlisted `SupportContext`; admins
 *   who are real members keep their real role.
 */
export async function resolveOrganizationAccess(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  options: ResolveOrganizationAccessOptions = {}
): Promise<OrganizationAccess> {
  let rows: { role: OrganizationRole }[];
  let membershipObserved = true;
  if (options.membershipRows) {
    rows = options.membershipRows;
  } else {
    try {
      rows = await loadEffectiveMembershipRows(ctx.user.id, organizationId);
    } catch (membershipError) {
      if (!ctx.user.is_admin) throw membershipError;
      if (isSupportAccessEnabled()) {
        // ON must fail closed: an unreadable membership could otherwise look
        // like a non-member and produce a misleading grant-required denial.
        throw supportLookupFailedError();
      }
      // OFF: elevation telemetry must never be the reason a request fails.
      membershipObserved = false;
      rows = [];
    }
  }
  const enabled = isSupportAccessEnabled();
  const isAdmin = ctx.user.is_admin;
  const role = effectiveMembershipRole(rows, options.roles);
  if (role && (!isAdmin || enabled)) {
    return { kind: 'member', role };
  }

  if (!isAdmin) {
    if (rows.length === 0 && (await organizationState(organizationId)) === 'deleted') {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message:
        rows.length > 0
          ? 'You do not have the required organizational role to access this feature'
          : 'You do not have access to this organization',
    });
  }

  if (!enabled) {
    const observation = {
      membershipRole: membershipObserved ? effectiveMembershipRole(rows) : null,
      wouldPassWithoutAdmin: membershipObserved ? role !== null : null,
    };
    if (!options.skipOrganizationLiveness) {
      const organizationResult = settle(
        db
          .select({ id: organizations.id })
          .from(organizations)
          .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
          .limit(1)
      );
      const result = await organizationResult;
      if (!result.ok) {
        // Parent ordering: a lookup failure is attributed before rethrowing.
        await recordKiloAdminElevation(ctx, {
          reason: options.auditReason ?? 'organization_access',
          target: organizationTarget(organizationId),
          ...observation,
        });
        throw result.error;
      }
      if (!result.value[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
    }
    await recordKiloAdminElevation(ctx, {
      reason: options.auditReason ?? 'organization_access',
      target: organizationTarget(organizationId),
      ...observation,
    });
    return { kind: 'legacy_admin', role: 'owner' };
  }

  if (!options.skipOrganizationLiveness) {
    const live = options.organizationIsLive ?? (await isLiveOrganization(organizationId));
    if (!live) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
  }

  if (rows.length > 0) {
    // A real member without the required role keeps the role-specific error;
    // a support grant cannot elevate over an existing membership.
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }

  const { surface, key } = supportKeyFor(ctx, options);
  const supportActionId = supportActionIdFor(ctx, options, key);
  let evaluation;
  try {
    evaluation = await evaluateSupportAccess({
      actorKiloUserId: ctx.user.id,
      organizationId,
      requiredActionClass: requiredActionClassFor(ctx, options),
      roles: options.roles,
      surface,
      key,
      supportActionId,
    });
  } catch {
    throw supportLookupFailedError();
  }

  if (evaluation.access) {
    if (evaluation.access.actionClass === 'support_write') {
      const entry = key
        ? findSupportAllowEntry({ surface, key, actionClass: 'support_write' })
        : undefined;
      if (entry?.stepUp === 'fresh') {
        await supportStepUpPort.requireFresh({
          userId: ctx.user.id,
          action: 'support_write_use',
          credential: ctx.credential,
          webSessionId: ctx.webSessionId ?? null,
          route: ctx.trpcPath ?? null,
          method: ctx.trpcType ?? null,
          surface,
        });
      }
      await recordSupportWriteUse({
        grantId: evaluation.access.grantId,
        actorKiloUserId: ctx.user.id,
        organizationId,
        supportActionId: evaluation.access.supportActionId,
      });
    }
    await recordKiloAdminElevation(ctx, {
      reason: options.auditReason ?? 'organization_access',
      target: organizationTarget(organizationId),
      membershipRole: membershipObserved ? effectiveMembershipRole(rows) : null,
      wouldPassWithoutAdmin: membershipObserved ? role !== null : null,
      supportDecision: evaluation.decision,
      supportGrantId: evaluation.grantId,
      supportActionId,
      inventoryId: evaluation.access.inventoryId,
    });
    return evaluation.access;
  }

  let grantStatus: 'expired' | 'revoked' | null = null;
  if (evaluation.decision === 'deny_no_grant') {
    try {
      grantStatus = await latestSupportGrantStatus({
        actorKiloUserId: ctx.user.id,
        organizationId,
      });
    } catch {
      throw supportLookupFailedError();
    }
  }
  await recordKiloAdminElevation(ctx, {
    reason: options.auditReason ?? 'organization_access',
    target: organizationTarget(organizationId),
    membershipRole: membershipObserved ? effectiveMembershipRole(rows) : null,
    wouldPassWithoutAdmin: membershipObserved ? role !== null : null,
    supportDecision: evaluation.decision,
    supportGrantId: evaluation.grantId,
    supportActionId,
    inventoryId: null,
  });
  throw deniedAccessError({
    decision: evaluation.decision,
    grantStatus,
  });
}

/**
 * The role the resolved access stands in for on the current procedure. A support
 * grant stands in for its allowlist entry's role. Reads the access a procedure
 * middleware already resolved, so a resolver that varies its response by role
 * does not resolve, audit, or deny a second time.
 */
export function organizationAccessRole(
  ctx: TRPCContext,
  access: OrganizationAccess
): OrganizationRole {
  return access.kind === 'support' ? supportRoleForCurrentSurface(ctx, access) : access.role;
}

/**
 * Returns a role for the caller, admitting a support grant only when the exact
 * procedure is on the allowlist. Use this instead of `ensureOrganizationAccess`
 * on allowlisted reads and writes.
 */
export async function ensureOrganizationAccess(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<OrganizationRole> {
  const access = await resolveOrganizationAccess(ctx, organizationId, { roles });
  const role = organizationAccessRole(ctx, access);
  if (roles && roles.length > 0 && !roles.includes(role)) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }
  return role;
}

/**
 * Membership-only gate for surfaces where a support grant can never stand in
 * (the fake `is_admin: false` contexts and credential issuers).
 */
export async function ensureMemberOrganizationAccess(
  user: { id: string },
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<OrganizationRole> {
  const rows = await loadEffectiveMembershipRows(user.id, organizationId);
  const role = effectiveMembershipRole(rows, roles);
  if (role) return role;
  if (rows.length === 0 && (await organizationState(organizationId)) === 'deleted') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message:
      rows.length > 0
        ? 'You do not have the required organizational role to access this feature'
        : 'You do not have access to this organization',
  });
}

export async function requireLiveOrganization(organizationId: Organization['id']): Promise<void> {
  if (!(await isLiveOrganization(organizationId))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
}

/**
 * Platform operation on a live organization. Records the same membership
 * observation as the parent membership-based path, so off-mode telemetry keeps
 * its fields.
 */
export async function requireLiveOrganizationForPlatformAdmin(
  ctx: TRPCContext,
  organizationId: Organization['id'],
  roles?: OrganizationRole[]
): Promise<void> {
  await requireLiveOrganization(organizationId);
  const observation = await observeMembershipRole(
    () => loadEffectiveMembershipRows(ctx.user.id, organizationId),
    roles
  );
  await recordKiloAdminElevation(ctx, {
    reason: 'organization_access',
    target: organizationTarget(organizationId),
    ...observation,
  });
}

/**
 * Re-checks the exact current procedure against the allowlist before treating a
 * support grant as a role. A resolver that calls `ensureOrganizationAccess`
 * after the organization middleware therefore keeps least privilege: the
 * middleware may admit a read, but a later `manage` assertion still fails.
 */
function supportRoleForCurrentSurface(ctx: TRPCContext, access: SupportContext): OrganizationRole {
  if (ctx.trpcPath === undefined) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Explicit support access requires an identified surface',
    });
  }
  const entry = findSupportAllowEntry({
    surface: 'trpc',
    key: ctx.trpcPath,
    actionClass: access.actionClass,
  });
  if (!entry) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }
  return supportStandInRole(entry);
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
  if (isSupportAccessEnabled()) {
    const rolesByOrg = groupRolesByOrganization(
      await selectCallerRoleRows(
        ctx.user.id,
        column => inArray(column, uniqueIds),
        callerRoleFields
      )
    );
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
                effectiveMembershipRole(
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
  if (ctx.user.is_admin && !isSupportAccessEnabled()) {
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
    const [organization] = rowsResult.value;
    if (!organization) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    return organization;
  }

  const rows = await loadEffectiveMembershipRowsWithOrganization(ctx.user.id, organizationId);
  const role = effectiveMembershipRole(rows, roles);
  if (role) {
    const organization = rows.find(row => row.role === role)?.organization;
    if (organization) return organization;
  }

  if (ctx.user.is_admin) {
    const organization = await getOrganizationById(organizationId);
    if (!organization) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    await resolveOrganizationAccess(ctx, organizationId, {
      roles,
      auditReason: 'organization_fetch',
      membershipRows: rows,
      organizationIsLive: true,
    });
    return organization;
  }

  if (rows.length === 0 && (await organizationState(organizationId)) === 'deleted') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message:
      rows.length > 0
        ? 'You do not have the required organizational role to access this feature'
        : 'You do not have access to this organization',
  });
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
