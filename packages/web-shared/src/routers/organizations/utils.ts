import type { Organization, User } from '@kilocode/db/schema';
import { organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  requireSupportWriteUseStepUp,
  supportStepUpCredential,
} from '@kilocode/web-shared/lib/admin/support-step-up';
import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
  ORGANIZATION_ROLE_PRIORITY,
} from '@kilocode/app-shared/organizations';
import { baseProcedure, requireStaffAuthority } from '@kilocode/web-shared/lib/trpc/init';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import type {
  StaffAdmission,
  StaffAuthorization,
} from '@kilocode/web-shared/lib/admin/admin-guard';
import type { StepUpRequirementPayload } from '@kilocode/web-shared/lib/admin/privileged-access';
import { requireStaffAuthorityForRequest } from '@kilocode/web-shared/lib/user/server';
import type { FailureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { AdminNetworkDenialReason } from '@kilocode/web-shared/lib/admin/admin-network';
import type { NextResponse } from 'next/server';
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
  type SupportAccessReason,
  type SupportContext,
  type SupportSurface,
} from '@kilocode/web-shared/lib/admin/support-access';
import {
  evaluateSupportAccess,
  isLiveOrganization,
  latestSupportGrantStatus,
  organizationState,
  recordSupportWriteUse,
  type SupportResolution,
} from '@kilocode/web-shared/lib/admin/support-access-resolver';
import { TRPCError } from '@trpc/server';
import { and, inArray, isNull } from 'drizzle-orm';
import * as z from 'zod';
import {
  callerRoleFields,
  loadEffectiveMembershipRows,
  loadEffectiveMembershipRowsWithOrganization,
  selectCallerRoleRows,
  type CallerRoleRow,
} from '@kilocode/web-shared/lib/organizations/effective-membership';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';

const warnSupportLookupFailure = sentryLogger('support_access_lookup', 'error');

export const OrganizationIdInputSchema = z.object({
  organizationId: z.uuid(),
});

/** The allowed-roles default: an absent or empty filter means the full priority order. */
function defaultedAllowedRoles(roles?: readonly OrganizationRole[]): readonly OrganizationRole[] {
  return roles && roles.length > 0 ? roles : ORGANIZATION_ROLE_PRIORITY;
}

/**
 * The one highest-role rule: the first role in ORGANIZATION_ROLE_PRIORITY that
 * the caller holds and the caller's allowed-role filter permits.
 */
function highestOrganizationRole(
  roles: readonly OrganizationRole[],
  allowedRoles?: readonly OrganizationRole[]
): OrganizationRole | null {
  const allowed = defaultedAllowedRoles(allowedRoles);
  return (
    ORGANIZATION_ROLE_PRIORITY.find(role => allowed.includes(role) && roles.includes(role)) ?? null
  );
}

export function effectiveMembershipRole(
  rows: { role: OrganizationRole }[],
  roles?: readonly OrganizationRole[]
): OrganizationRole | null {
  return highestOrganizationRole(
    rows.map(row => row.role),
    roles
  );
}

export function settle<T>(
  promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value: T) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
}

export async function observeMembershipRole(
  loader: () => Promise<{ role: OrganizationRole }[]>,
  roles?: readonly OrganizationRole[]
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

/** The successful `getUserFromAuth` result a REST or server-component caller holds. */
export type OrganizationRestAuth = Parameters<typeof requireStaffAuthorityForRequest>[0];

type CallerRoleRowWithOrganization = CallerRoleRow & { organization: Organization };

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
  | 'webSessionPepper'
  | 'adminAdmission'
  | 'stepUpClaims'
> & {
  auditSurface?: 'trpc' | 'rest' | 'server-component';
  auditMethod?: string;
  delegatedWorkload?: boolean;
  /**
   * Set by a REST or server-component caller. Its staff branch then admits
   * through `requireStaffAuthorityForRequest` with `headersList` and
   * `auditMethod`, and a refusal carries the adapter's response
   * ({@link StaffRequestRefusal}).
   */
  restAuth?: OrganizationRestAuth;
};

/**
 * The organization access context of a REST handler or server component: the
 * successful `getUserFromAuth` result plus the request's own headers and
 * method, so a staff admission checks the network and binds its proof to this
 * request. Never build a tRPC context for such a caller.
 */
export function organizationRestAccessContext(
  auth: OrganizationRestAuth,
  request: { headers: Headers; method?: string; surface?: 'rest' | 'server-component' }
): OrganizationAccessContext & {
  credential: OrganizationRestAuth['credential'];
  headersList: Headers;
} {
  return {
    user: auth.user,
    tokenSource: auth.tokenSource,
    internalApiUse: auth.internalApiUse,
    credential: auth.credential,
    webSessionId: auth.webSessionId,
    webSessionPepper: auth.webSessionPepper,
    headersList: request.headers,
    restAuth: auth,
    auditSurface: request.surface ?? 'rest',
    auditMethod: request.method,
    delegatedWorkload: auth.cloudAgentAuthority !== undefined,
  };
}

export type ResolveOrganizationAccessOptions = {
  roles?: readonly OrganizationRole[];
  /** Exact REST route pattern or inventory key. Defaults to the tRPC path. */
  supportKey?: string | null;
  supportActionId?: string | null;
  surface?: SupportSurface;
  /** Overrides the action class derived from the procedure type or request method. */
  requiredActionClass?: SupportActionClass;
  /** Telemetry reason for the elevation event. Defaults to the tRPC reason. */
  auditReason?: KiloAdminElevationReason;
  /** Reuse a membership read the caller already performed. */
  membershipRows?: { role: OrganizationRole }[];
};

function supportKeyFor(
  ctx: OrganizationAccessContext,
  options: ResolveOrganizationAccessOptions
): { surface: SupportSurface; key: string | null } {
  const surface = options.surface ?? (ctx.trpcPath === undefined ? 'rest' : 'trpc');
  const key = options.supportKey !== undefined ? options.supportKey : (ctx.trpcPath ?? null);
  return { surface, key };
}

/**
 * The action class of the request, which is both the staff admission's class
 * and the class a support grant must cover: a tRPC mutation, or a REST request
 * other than GET or HEAD (or one whose method is unknown), is a write. A
 * server-component render is a read.
 */
function requiredActionClassFor(
  ctx: Pick<OrganizationAccessContext, 'trpcPath' | 'trpcType' | 'auditSurface' | 'auditMethod'>,
  options: Pick<ResolveOrganizationAccessOptions, 'requiredActionClass'>
): SupportActionClass {
  if (options.requiredActionClass) return options.requiredActionClass;
  if (ctx.trpcPath !== undefined) {
    return ctx.trpcType === 'mutation' ? 'support_write' : 'support_read';
  }
  if (ctx.auditSurface === 'server-component') return 'support_read';
  const method = ctx.auditMethod?.toUpperCase();
  return method === 'GET' || method === 'HEAD' ? 'support_read' : 'support_write';
}

/**
 * A refused REST or server-component staff admission, carried as the cause of
 * the `TRPCError` the organization helpers throw. The route answers with
 * `response` (the adapter's 401 or 403, with the step-up requirement when one
 * applies) instead of a generic denial. `adminNetworkDenial` is set when the
 * admin network allowlist refused the request, so a page can show that reason.
 */
export class StaffRequestRefusal extends Error {
  constructor(
    readonly response: NextResponse<FailureResult<string>>,
    readonly stepUp: StepUpRequirementPayload | undefined,
    readonly adminNetworkDenial?: AdminNetworkDenialReason
  ) {
    super('Staff admission refused');
    this.name = 'StaffRequestRefusal';
  }
}

/**
 * What a staff admission hands the organization helpers. `stepUp` and
 * `decision` are present only for a tRPC admission, whose request proof a
 * support write then reuses instead of spending a second one.
 */
export type OrganizationStaffAdmission = Pick<StaffAdmission, 'user'> &
  Partial<Pick<StaffAdmission, 'stepUp' | 'decision'>>;

/**
 * The one staff admission for acting on an organization without a qualifying
 * membership role: primary role re-read, browser session, network, then
 * `authorize`, then the step-up proof for the request's action class against
 * this one organization. A write is `support_write`, whose proof is bound to
 * this operation and organization and is spent once.
 *
 * `authorize` receives the primary row and runs before the proof: it holds
 * the liveness and grant checks, so a request it refuses never prompts for or
 * spends a proof. It runs on every call.
 *
 * The tRPC adapter memoizes the proof per procedure call, so a middleware and
 * a resolver that both call this share one admission; call this rather than
 * `requireStaffAuthority` so the memo key is identical. A REST caller sets
 * `ctx.restAuth` and calls this at most once per request.
 */
export async function requireOrganizationStaffAuthority(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  actionClass: SupportActionClass = requiredActionClassFor(ctx, {}),
  authorize?: StaffAuthorization
): Promise<OrganizationStaffAdmission> {
  const target = { kind: 'organization', id: organizationId } as const;
  if (!ctx.restAuth) return requireStaffAuthority(ctx, { actionClass, target, authorize });

  const admitted = await requireStaffAuthorityForRequest(ctx.restAuth, {
    actionClass,
    target,
    authorize,
    surface: ctx.auditSurface === 'server-component' ? 'server-component' : 'rest',
    requestHeaders: ctx.headersList,
    requestMethod: ctx.auditMethod,
  });
  if (admitted.authFailedResponse) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
      cause: new StaffRequestRefusal(
        admitted.authFailedResponse,
        admitted.stepUp,
        admitted.adminNetworkDenial
      ),
    });
  }
  return { user: admitted.user };
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

function supportAccessReasonFor(params: {
  decision: SupportDecision | null;
  grantStatus: 'expired' | 'revoked' | null;
}): SupportAccessReason {
  if (params.grantStatus === 'expired') return 'support_grant_expired';
  if (params.grantStatus === 'revoked') return 'support_grant_revoked';
  if (params.decision === 'deny_not_allowlisted' || params.decision === 'deny_never_list') {
    return 'support_access_not_allowlisted';
  }
  // Both a too-weak grant and a grant whose role cannot stand in for the
  // request are reported to the client as the action-class refusal; a distinct
  // client code is deliberately not added.
  if (params.decision === 'deny_action_class' || params.decision === 'deny_actor_permission') {
    return 'support_access_action_class';
  }
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
 * The single refusal for a caller that holds no effective membership role: a
 * soft-deleted organization reads as missing, and a caller that is a member of
 * a live organization gets the role-specific sentence.
 */
async function organizationRoleDeniedError(
  rows: { role: OrganizationRole }[],
  organizationId: Organization['id']
): Promise<TRPCError> {
  if (rows.length === 0 && (await organizationState(organizationId)) === 'deleted') {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  return new TRPCError({
    code: 'UNAUTHORIZED',
    message:
      rows.length > 0
        ? 'You do not have the required organizational role to access this feature'
        : 'You do not have access to this organization',
  });
}

/** What {@link resolveOrganizationAccess} admitted, with the actor that holds it. */
type ResolvedOrganizationAccess = {
  access: OrganizationAccess;
  /** The authenticated row for a member; the current primary row for staff. */
  user: User;
  /** For staff, the live row the admission read when the caller asked for it. */
  organization: Organization | null;
};

/** The access, its actor and the live organization row. */
export type OrganizationAccessWithOrganization = ResolvedOrganizationAccess & {
  organization: Organization;
};

/**
 * The single support-access decision point for organization access.
 *
 * - A real membership role the request allows always passes, for staff too,
 *   and never reaches a staff check or a grant.
 * - Every other staff path passes {@link requireOrganizationStaffAuthority}:
 *   primary role, browser session and network first, then the liveness and
 *   grant checks, and the step-up proof only once those approved the request.
 * - OFF then keeps today's `is_admin` -> `owner` shortcut.
 * - ON admits only an active, allowlisted `SupportContext`, and never over an
 *   existing membership.
 */
export async function resolveOrganizationAccess(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  options: ResolveOrganizationAccessOptions = {}
): Promise<OrganizationAccess> {
  return (await resolveAccess(ctx, organizationId, options, false)).access;
}

/**
 * {@link resolveOrganizationAccess} plus the organization row and the actor.
 * A member gets the organization from its own membership rows. For staff, the
 * admission's liveness check reads the full row once, before the proof, and
 * it is returned only after the admission succeeded.
 */
export async function resolveOrganizationAccessAndFetchOrg(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  options: Omit<ResolveOrganizationAccessOptions, 'membershipRows'> & {
    membershipRows: CallerRoleRowWithOrganization[];
  }
): Promise<OrganizationAccessWithOrganization> {
  const resolved = await resolveAccess(ctx, organizationId, options, true);
  const { access } = resolved;
  const organization =
    access.kind === 'member'
      ? options.membershipRows.find(row => row.role === access.role)?.organization
      : resolved.organization;
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  return { ...resolved, organization };
}

async function resolveAccess(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  options: ResolveOrganizationAccessOptions,
  readOrganization: boolean
): Promise<ResolvedOrganizationAccess> {
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
      // OFF: the staff admission below authorizes without the membership.
      membershipObserved = false;
      rows = [];
    }
  }
  const role = effectiveMembershipRole(rows, options.roles);
  if (role) {
    return { access: { kind: 'member', role }, user: ctx.user, organization: null };
  }

  if (!ctx.user.is_admin) {
    throw await organizationRoleDeniedError(rows, organizationId);
  }

  const enabled = isSupportAccessEnabled();
  if (enabled && rows.length > 0) {
    // A real member without the required role keeps the role-specific error;
    // a support grant cannot elevate over an existing membership.
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'You do not have the required organizational role to access this feature',
    });
  }

  const requiredActionClass = requiredActionClassFor(ctx, options);
  const auditReason = options.auditReason ?? 'organization_access';
  const target = organizationTarget(organizationId);
  const observation = {
    membershipRole: membershipObserved ? effectiveMembershipRole(rows) : null,
    wouldPassWithoutAdmin: membershipObserved ? false : null,
  };
  const { surface, key } = supportKeyFor(ctx, options);
  const supportActionId = supportActionIdFor(ctx, options, key);
  // The grant this request's admission approved, set by `authorize` below.
  const approved: { resolution: SupportResolution | null } = { resolution: null };
  // The live row `authorize` read; returned only once the admission succeeded.
  const loaded: { organization: Organization | null } = { organization: null };
  const isLive = async (): Promise<boolean> => {
    if (!readOrganization) return isLiveOrganization(organizationId);
    loaded.organization = await getOrganizationById(organizationId);
    return loaded.organization !== null;
  };

  const staff = await requireOrganizationStaffAuthority(
    ctx,
    organizationId,
    requiredActionClass,
    async actor => {
      const actorCtx = { ...ctx, user: actor };
      if (!enabled) {
        const result = await settle(isLive());
        if (!result.ok) {
          // Parent ordering: a lookup failure is attributed before rethrowing.
          await recordKiloAdminElevation(actorCtx, { reason: auditReason, target, ...observation });
          throw result.error;
        }
        if (!result.value) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
        }
        return;
      }

      if (!(await isLive())) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }
      let evaluation: SupportResolution;
      try {
        evaluation = await evaluateSupportAccess({
          actorKiloUserId: actor.id,
          organizationId,
          requiredActionClass,
          roles: options.roles,
          surface,
          key,
          supportActionId,
        });
      } catch {
        throw supportLookupFailedError();
      }
      if (evaluation.access) {
        approved.resolution = evaluation;
        return;
      }

      let grantStatus: 'expired' | 'revoked' | null = null;
      if (evaluation.decision === 'deny_no_grant') {
        try {
          grantStatus = await latestSupportGrantStatus({
            actorKiloUserId: actor.id,
            organizationId,
          });
        } catch {
          throw supportLookupFailedError();
        }
      }
      await recordKiloAdminElevation(actorCtx, {
        reason: auditReason,
        target,
        ...observation,
        supportDecision: evaluation.decision,
        supportGrantId: evaluation.grantId,
        supportActionId,
        inventoryId: null,
        supportInheritedFromOrganizationId: evaluation.inheritedFromOrganizationId,
      });
      throw deniedAccessError({
        decision: evaluation.decision,
        grantStatus,
      });
    }
  );
  const actorCtx = { ...ctx, user: staff.user };
  const resolved = (access: OrganizationAccess): ResolvedOrganizationAccess => ({
    access,
    user: staff.user,
    organization: loaded.organization,
  });

  if (!enabled) {
    await recordKiloAdminElevation(actorCtx, { reason: auditReason, target, ...observation });
    return resolved({ kind: 'legacy_admin', role: 'owner' });
  }

  const resolution = approved.resolution;
  const access = resolution?.access;
  if (!resolution || !access) {
    throw new Error('A staff admission returned without an approved support grant');
  }
  if (access.actionClass === 'support_write') {
    const entry = key
      ? findSupportAllowEntry({ surface, key, actionClass: 'support_write' })
      : undefined;
    let firstUseInRequest = true;
    if (entry?.stepUp === 'fresh') {
      // The admission spent this write's proof and its decision covers this
      // write, so this records the use without a second spend; it still
      // refuses while step-up is switched off.
      firstUseInRequest = await requireSupportWriteUseStepUp({
        userId: staff.user.id,
        organizationId,
        upstreamStepUpState: staff.stepUp,
        upstreamStepUpDecision: staff.decision ?? undefined,
        claimStore: ctx.stepUpClaims,
        claimKey: `${organizationId}:${surface}:${key ?? ''}`,
        credential: supportStepUpCredential(ctx.credential),
        webSessionId: ctx.webSessionId ?? null,
        route: ctx.trpcPath ?? null,
        method: ctx.trpcType ?? null,
        surface,
      });
    }
    if (firstUseInRequest) {
      await recordSupportWriteUse({
        grantId: access.grantId,
        actorKiloUserId: staff.user.id,
        grantOrganizationId: access.inheritedFromOrganizationId ?? organizationId,
        targetOrganizationId: organizationId,
        supportActionId: access.supportActionId,
      });
    }
  }
  await recordKiloAdminElevation(actorCtx, {
    reason: auditReason,
    target,
    ...observation,
    supportDecision: resolution.decision,
    supportGrantId: resolution.grantId,
    supportActionId,
    inventoryId: access.inventoryId,
    supportInheritedFromOrganizationId: access.inheritedFromOrganizationId,
  });
  return resolved(access);
}

/**
 * The role the resolved access stands in for on the current procedure. A support
 * grant stands in for its allowlist entry's role. Reads the access a procedure
 * middleware already resolved, so a resolver that varies its response by role
 * does not resolve, audit, or deny a second time.
 */
export function organizationAccessRole(
  ctx: Pick<OrganizationAccessContext, 'trpcPath'>,
  access: OrganizationAccess
): OrganizationRole {
  return access.kind === 'support' ? supportRoleForCurrentSurface(ctx, access) : access.role;
}

/**
 * Returns a role for the caller, admitting a support grant only when the exact
 * procedure is on the allowlist.
 */
export async function ensureOrganizationAccess(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  roles?: readonly OrganizationRole[]
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
  roles?: readonly OrganizationRole[]
): Promise<OrganizationRole> {
  const rows = await loadEffectiveMembershipRows(user.id, organizationId);
  const role = effectiveMembershipRole(rows, roles);
  if (role) return role;
  throw await organizationRoleDeniedError(rows, organizationId);
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
  roles?: readonly OrganizationRole[]
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
function supportRoleForCurrentSurface(
  ctx: Pick<OrganizationAccessContext, 'trpcPath'>,
  access: SupportContext
): OrganizationRole {
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

function groupRolesByOrganization(rows: CallerRoleRow[]): Map<string, OrganizationRole[]> {
  const rolesByOrg = new Map<string, OrganizationRole[]>();
  for (const row of rows) {
    const list = rolesByOrg.get(row.organizationId) ?? [];
    list.push(row.role);
    rolesByOrg.set(row.organizationId, list);
  }
  return rolesByOrg;
}

/**
 * Resolves the caller's effective role for each of `organizationIds` in a fixed
 * number of queries instead of one per organization.
 *
 * The role is the highest one among the caller's direct and inherited
 * membership rows (a parent org owner, admin, or billing_manager inherits on
 * its children; only live organizations contribute rows). Organizations
 * without such a role are absent from the returned map.
 *
 * With support access OFF, a platform admin whose memberships do not give an
 * allowed role in every requested organization passes the staff admission
 * once for the batch (`support_read`, no single organization target), and
 * then every live organization (not deleted) gets `owner`; the elevation is
 * recorded once with reason `organization_access_batch`. Only queries batch
 * organization roles: a write needs a proof bound to one organization, so a
 * staff batch outside a query is refused.
 *
 * This batch path never consults a support grant. Grants are resolved per
 * organization by {@link resolveOrganizationAccess} against the procedure
 * allowlist, and no procedure that gates on this helper is on that allowlist.
 */
export async function getOrganizationsAccessRoles(
  ctx: TRPCContext,
  organizationIds: Organization['id'][],
  roles?: readonly OrganizationRole[]
): Promise<Map<string, OrganizationRole>> {
  const uniqueIds = Array.from(new Set(organizationIds));
  const result = new Map<string, OrganizationRole>();
  if (uniqueIds.length === 0) {
    return result;
  }
  const rolesByOrg = groupRolesByOrganization(
    await selectCallerRoleRows(ctx.user.id, column => inArray(column, uniqueIds), callerRoleFields)
  );
  const membershipAllowsAll = uniqueIds.every(
    id => highestOrganizationRole(rolesByOrg.get(id) ?? [], roles) !== null
  );
  if (isSupportAccessEnabled() || !ctx.user.is_admin || membershipAllowsAll) {
    for (const [organizationId, memberRoles] of rolesByOrg) {
      const best = highestOrganizationRole(memberRoles);
      if (best) result.set(organizationId, best);
    }
    return result;
  }

  if (ctx.trpcType !== 'query') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  // Only organizations that exist and are live are elevated, matching
  // getOrganizationById. The read runs after the network and session checks.
  let liveIds: string[] = [];
  const staff = await requireStaffAuthority(ctx, {
    actionClass: 'support_read',
    target: { kind: 'organization', id: null },
    authorize: async () => {
      const liveOrgRows = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(inArray(organizations.id, uniqueIds), isNull(organizations.deleted_at)));
      liveIds = liveOrgRows.map(row => row.id);
    },
  });
  if (liveIds.length === 0) {
    return result;
  }
  const grant = await elevateViaKiloAdmin(
    { ...ctx, user: staff.user },
    {
      reason: 'organization_access_batch',
      target: organizationsTarget(liveIds),
      grant: 'owner',
      membershipRole: null,
      wouldPassWithoutAdmin: liveIds.every(
        id => highestOrganizationRole(rolesByOrg.get(id) ?? [], roles) !== null
      ),
    }
  );
  for (const id of liveIds) result.set(id, grant);
  return result;
}

/**
 * Batched access check over {@link getOrganizationsAccessRoles}: throws
 * `UNAUTHORIZED` unless every requested organization carries one of the allowed
 * roles. It consults no support grant, as that helper documents.
 */
export async function ensureOrganizationsAccess(
  ctx: TRPCContext,
  organizationIds: Organization['id'][],
  roles?: readonly OrganizationRole[]
): Promise<void> {
  const accessByOrg = await getOrganizationsAccessRoles(ctx, organizationIds, roles);
  const allowedRoles = defaultedAllowedRoles(roles);
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

/**
 * The organization, for a caller with an allowed membership role or, for
 * staff, once {@link resolveOrganizationAccessAndFetchOrg} admitted the staff
 * branch; the staff row is the one the admission read.
 */
export async function ensureOrganizationAccessAndFetchOrg(
  ctx: OrganizationAccessContext,
  organizationId: Organization['id'],
  roles?: readonly OrganizationRole[]
): Promise<Organization> {
  const rows = await loadEffectiveMembershipRowsWithOrganization(ctx.user.id, organizationId);
  const { organization } = await resolveOrganizationAccessAndFetchOrg(ctx, organizationId, {
    roles,
    auditReason: 'organization_fetch',
    membershipRows: rows,
  });
  return organization;
}

/**
 * Membership rows read through the caller's read client when it set one (the AI
 * gateway passes the local replica, since `db` is a cross-region round trip from
 * `sfo1`). Only a granting result is trusted: rows that grant no role return
 * undefined, so `resolveOrganizationAccess` re-reads the primary and replica lag
 * cannot deny a new member. A failed replica read falls back the same way.
 * Revocation is eventually consistent instead: a member just removed or demoted
 * keeps passing until the replica catches up, which `packages/web-shared/AGENTS.md`
 * accepts for gateway auth reads. Only the read-only model-list gate sets `fromDb`.
 */
async function loadReplicaMembershipRows(
  ctx: TRPCContext,
  organizationId: Organization['id']
): Promise<CallerRoleRow[] | undefined> {
  if (!ctx.fromDb) return undefined;
  const rows = await loadEffectiveMembershipRows(ctx.user.id, organizationId, ctx.fromDb).catch(
    () => undefined
  );
  return rows && effectiveMembershipRole(rows) ? rows : undefined;
}

// Custom procedure that ensures user has access to the organization (any role)
export const organizationMemberProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    const organizationAccess = await resolveOrganizationAccess(ctx, input.organizationId, {
      membershipRows: await loadReplicaMembershipRows(ctx, input.organizationId),
    });
    return next({ ctx: { organizationAccess } });
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

// Membership-only procedures for payment, credential, and OAuth surfaces on the
// support never-list (SUPPORT_NEVER_KEYS): only a real direct or inherited
// membership passes, so neither a staff admission nor a support grant stands in.
export const organizationMemberOnlyMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureMemberOrganizationAccess(ctx.user, input.organizationId);
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next();
  });

export const organizationBillingMemberProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureMemberOrganizationAccess(
      ctx.user,
      input.organizationId,
      ORGANIZATION_BILLING_ROLES
    );
    return next();
  });

export const organizationBillingMemberMutationProcedure = baseProcedure
  .input(OrganizationIdInputSchema)
  .use(async ({ ctx, next, input }) => {
    await ensureMemberOrganizationAccess(
      ctx.user,
      input.organizationId,
      ORGANIZATION_BILLING_ROLES
    );
    await requireActiveSubscriptionOrTrial(input.organizationId);
    return next();
  });
