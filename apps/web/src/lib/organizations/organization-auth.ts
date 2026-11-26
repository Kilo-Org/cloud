import 'server-only';
import { headers } from 'next/headers';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { Organization, User } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import type { AdminAccessSurface } from '@kilocode/web-shared/lib/admin/admin-access-log';
import type { AdminNetworkDenialReason } from '@kilocode/web-shared/lib/admin/admin-network';
import type { StepUpRequirementPayload } from '@kilocode/web-shared/lib/admin/privileged-access';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import type { CustomResult } from '@kilocode/web-shared/lib/maybe-result';
import { successResult } from '@kilocode/web-shared/lib/maybe-result';
import {
  effectiveMembershipRole,
  organizationRestAccessContext,
  resolveOrganizationAccessAndFetchOrg,
  StaffRequestRefusal,
  type OrganizationAccessWithOrganization,
} from '@kilocode/web-shared/routers/organizations/utils';
import { loadEffectiveMembershipRowsWithOrganization } from '@kilocode/web-shared/lib/organizations/effective-membership';
import {
  findSupportAllowEntry,
  isSupportAccessReason,
  supportStandInRole,
  type OrganizationAccess,
  type SupportAccessReason,
  type SupportActionClass,
  type SupportSurface,
} from '@kilocode/web-shared/lib/admin/support-access';
import { TRPCError } from '@trpc/server';
import z from 'zod';
import type { StepUpRequirement } from '@/components/admin/step-up/step-up-error';

const warnInSentry = sentryLogger('org_auth', 'warning');

/**
 * The surfaces this helper serves: it authenticates from the request's own
 * headers and cookies, so it is never a tRPC procedure.
 */
type OrganizationRequestSurface = Exclude<AdminAccessSurface, 'trpc'>;

/**
 * The caller-facing surface and the support-allowlist surface share one
 * vocabulary today, but they are separate declarations. `Record` makes a new
 * request surface a typecheck error here until it is mapped, so an audit
 * surface can never reach the allowlist lookup unchecked.
 */
const SUPPORT_SURFACE_BY_REQUEST_SURFACE: Record<OrganizationRequestSurface, SupportSurface> = {
  rest: 'rest',
  'server-component': 'server-component',
};

type UserWithRole = User & {
  readonly role: OrganizationRole;
};

type AuthorizedOrgData = {
  user: UserWithRole;
  organization: Organization;
  access: OrganizationAccess;
};
const UUIDSchema = z.uuid();

export type OrgAccessDenial = {
  status: number;
  reason: SupportAccessReason | null;
  isPlatformAdmin: boolean;
};

type DataOrNextError<T> = CustomResult<
  {
    data: T;
    nextResponse?: never;
    denial?: never;
    stepUp?: never;
    adminNetworkDenial?: never;
  },
  {
    data?: never;
    nextResponse: NextResponse<{ error: string }>;
    denial?: OrgAccessDenial;
    /** Set when a staff admission asked for step-up; a page renders the gate from it. */
    stepUp?: StepUpRequirement;
    /** Set when the admin network allowlist refused a staff admission. */
    adminNetworkDenial?: AdminNetworkDenialReason;
  }
>;

/** The page-gate shape of a step-up refusal; the gate treats a missing binding as none. */
function stepUpRequirementFrom(
  payload: StepUpRequirementPayload | undefined
): StepUpRequirement | undefined {
  return payload && { ...payload, binding: payload.binding ?? undefined };
}

export async function getAuthorizedOrgContext(
  id: Organization['id'],
  roles?: readonly OrganizationRole[],
  options: {
    // used only in testing because mocking getUserFromAuth doesn't work with jest
    // due to the way next module loading works
    getUserFromAuthOverride?: typeof getUserFromAuth;
    /**
     * How this helper was reached. Defaults to `'rest'`; server-component pages
     * and layouts pass `'server-component'`. It labels the audit event the admin
     * branch emits and selects the surface the support-allowlist lookup matches.
     */
    surface?: OrganizationRequestSurface;
    /** The actual Request method when the caller has one. */
    requestMethod?: string;
    /**
     * The request's headers when the caller has the Request. Defaults to the
     * current request scope's headers. Used for the authentication and any
     * staff admission.
     */
    requestHeaders?: Headers;
    /**
     * Exact allowlist key for a support grant. Omitted means support is never
     * accepted here, even when support access is on.
     */
    supportKey?: string | null;
    /** Overrides the class from the method: GET/HEAD and server components read, others write. */
    requiredActionClass?: SupportActionClass;
    /**
     * Admit only a caller whose own membership gives an allowed role: no staff
     * branch, no support grant and no elevation record. A caller without such
     * a role gets the ordinary 404. Credential issuers use it.
     */
    membershipOnly?: boolean;
  } = {}
): Promise<DataOrNextError<AuthorizedOrgData>> {
  const { getUserFromAuthOverride, surface, requestMethod } = options;
  const auditSurface = surface ?? 'rest';
  const supportSurface = SUPPORT_SURFACE_BY_REQUEST_SURFACE[auditSurface];
  const getUserFromAuthFn =
    process.env.NODE_ENV === 'test' && getUserFromAuthOverride
      ? getUserFromAuthOverride
      : getUserFromAuth;

  const auth = await getUserFromAuthFn({
    adminOnly: false,
    requestMethod,
    requestHeaders: options.requestHeaders,
  });
  if (auth.authFailedResponse) {
    return { success: false, nextResponse: auth.authFailedResponse };
  }
  const { user } = auth;
  const { success, data, error } = UUIDSchema.safeParse(id);
  if (!success) {
    return {
      success: false,
      nextResponse: NextResponse.json({ error: error?.message || 'Invalid data' }, { status: 400 }),
    };
  }
  const organizationId = data;

  // A qualifying membership authorizes on its own, staff included, and never
  // reaches the staff admission.
  const memberRows = await loadEffectiveMembershipRowsWithOrganization(user.id, organizationId);
  const memberRole = effectiveMembershipRole(memberRows, roles);
  if (memberRole) {
    const organization = memberRows.find(row => row.role === memberRole)?.organization;
    if (organization) {
      return successResult({
        data: {
          user: { ...user, role: memberRole },
          organization,
          access: { kind: 'member', role: memberRole },
        },
      });
    }
  }

  if (!user.is_admin || options.membershipOnly) {
    warnInSentry(
      `User ${user.id} attempted to access organization ${organizationId} without sufficient permissions`
    );
    const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    return { success: false, nextResponse: res };
  }

  const requestHeaders = options.requestHeaders ?? (await headers());
  let resolved: OrganizationAccessWithOrganization;
  try {
    resolved = await resolveOrganizationAccessAndFetchOrg(
      organizationRestAccessContext(auth, {
        headers: requestHeaders,
        method: requestMethod,
        surface: auditSurface,
      }),
      organizationId,
      {
        roles,
        surface: supportSurface,
        supportKey: options.supportKey ?? null,
        requiredActionClass: options.requiredActionClass,
        auditReason: 'organization_access_rest',
        membershipRows: memberRows,
      }
    );
  } catch (accessError) {
    if (accessError instanceof TRPCError) {
      // The staff admission's own answer (401, 403, or a step-up requirement)
      // goes back unchanged, never as a generic 404.
      if (accessError.cause instanceof StaffRequestRefusal) {
        return {
          success: false,
          nextResponse: accessError.cause.response,
          stepUp: stepUpRequirementFrom(accessError.cause.stepUp),
          adminNetworkDenial: accessError.cause.adminNetworkDenial,
        };
      }
      warnInSentry(
        `User ${user.id} attempted to access organization ${organizationId} without sufficient permissions`
      );
      const supportReason = supportAccessReasonFromError(accessError);
      if (supportReason === 'support_grant_lookup_failed') {
        return {
          success: false,
          nextResponse: NextResponse.json(
            { error: 'Support access could not be verified', code: supportReason },
            { status: 503 }
          ),
          denial: { status: 503, reason: supportReason, isPlatformAdmin: user.is_admin },
        };
      }
      if (supportReason !== null) {
        return {
          success: false,
          nextResponse: NextResponse.json(
            { error: 'Support access required', code: supportReason },
            { status: 403 }
          ),
          denial: { status: 403, reason: supportReason, isPlatformAdmin: user.is_admin },
        };
      }
      const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      return { success: false, nextResponse: res };
    }
    throw accessError;
  }

  // A staff grant acts with the primary row its admission re-read.
  const { access, organization } = resolved;
  return successResult({
    data: {
      user: { ...resolved.user, role: roleForAccess(access, supportSurface, options.supportKey) },
      organization,
      access,
    },
  });
}

function supportAccessReasonFromError(error: TRPCError): SupportAccessReason | null {
  const cause = error.cause;
  if (cause === null || typeof cause !== 'object') return null;
  const reason = (cause as { supportAccessReason?: unknown }).supportAccessReason;
  return isSupportAccessReason(reason) ? reason : null;
}

function roleForAccess(
  access: OrganizationAccess,
  surface: SupportSurface,
  supportKey: string | null | undefined
): OrganizationRole {
  if (access.kind === 'member' || access.kind === 'legacy_admin') return access.role;
  const entry =
    supportKey === null || supportKey === undefined
      ? undefined
      : findSupportAllowEntry({
          surface,
          key: supportKey,
          actionClass: access.actionClass,
        });
  if (!entry) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Explicit support access is required for this organization',
    });
  }
  return supportStandInRole(entry);
}

/**
 * Only allowlisted REST reads use this. It guarantees the caller supplied an
 * exact support key so a grant cannot be accepted without an inventory match.
 */
export async function getAuthorizedOrgContextOrSupport(
  id: Organization['id'],
  supportKey: string,
  roles?: readonly OrganizationRole[],
  options: Omit<Parameters<typeof getAuthorizedOrgContext>[2], 'supportKey'> = {}
) {
  return getAuthorizedOrgContext(id, roles, { ...options, supportKey });
}
