import 'server-only';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import type { Organization, User } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import {
  organizationTarget,
  recordKiloAdminElevation,
  type AdminAccessSurface,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import type { CustomResult } from '@kilocode/web-shared/lib/maybe-result';
import { successResult } from '@kilocode/web-shared/lib/maybe-result';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  effectiveMembershipRole,
  loadEffectiveMembershipRows,
  loadEffectiveMembershipRowsWithOrganization,
  observeMembershipRole,
  resolveOrganizationAccess,
} from '@kilocode/web-shared/routers/organizations/utils';
import {
  findSupportAllowEntry,
  isSupportAccessEnabled,
  supportStandInRole,
  type OrganizationAccess,
  type SupportActionClass,
  type SupportSurface,
} from '@kilocode/web-shared/lib/admin/support-access';
import { TRPCError } from '@trpc/server';
import z from 'zod';

const warnInSentry = sentryLogger('org_auth', 'warning');

type UserWithRole = User & {
  readonly role: OrganizationRole;
};

type AuthorizedOrgData = {
  user: UserWithRole;
  organization: Organization;
  access: OrganizationAccess;
};
const UUIDSchema = z.uuid();
type DataOrNextError<T> = CustomResult<
  { data: T; nextResponse?: never },
  { data?: never; nextResponse: NextResponse<{ error: string }> }
>;

export async function getAuthorizedOrgContext(
  id: Organization['id'],
  roles?: OrganizationRole[],
  options: {
    // used only in testing because mocking getUserFromAuth doesn't work with jest
    // due to the way next module loading works
    getUserFromAuthOverride?: typeof getUserFromAuth;
    /**
     * How this helper was reached, for the audit event its admin branch emits.
     * Defaults to `'rest'`; server-component pages and layouts pass
     * `'server-component'`.
     */
    surface?: AdminAccessSurface;
    /** The actual Request method when the caller has one. */
    requestMethod?: string;
    /**
     * Exact allowlist key for a support grant. Omitted means support is never
     * accepted here, even when support access is on.
     */
    supportKey?: string | null;
    /** Required for a REST write; REST reads default to `support_read`. */
    requiredActionClass?: SupportActionClass;
  } = {}
): Promise<DataOrNextError<AuthorizedOrgData>> {
  const { getUserFromAuthOverride, surface, requestMethod } = options;
  const getUserFromAuthFn =
    process.env.NODE_ENV === 'test' && getUserFromAuthOverride
      ? getUserFromAuthOverride
      : getUserFromAuth;

  const { authFailedResponse, user, tokenSource, internalApiUse, cloudAgentAuthority } =
    await getUserFromAuthFn({
      adminOnly: false,
      requestMethod,
    });
  if (authFailedResponse) {
    return { success: false, nextResponse: authFailedResponse };
  }
  const { success, data, error } = UUIDSchema.safeParse(id);
  if (!success) {
    return {
      success: false,
      nextResponse: NextResponse.json({ error: error?.message || 'Invalid data' }, { status: 400 }),
    };
  }
  const organizationId = data;

  if (user.is_admin && !isSupportAccessEnabled()) {
    // Parent ordering: record the elevation before awaiting the organization
    // lookup, so a missing/deleted organization or a DB error is still
    // attributed.
    const organizationResult = getOrganizationById(organizationId).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error })
    );
    const observation = await observeMembershipRole(
      () => loadEffectiveMembershipRows(user.id, organizationId),
      roles
    );
    await recordKiloAdminElevation(
      {
        user,
        tokenSource,
        internalApiUse,
        delegatedWorkload: cloudAgentAuthority !== undefined,
        auditSurface: surface ?? 'rest',
        auditMethod: requestMethod,
      },
      {
        reason: 'organization_access_rest',
        target: organizationTarget(organizationId),
        ...observation,
      }
    );
    const lookup = await organizationResult;
    if (!lookup.ok) throw lookup.error;
    const organization = lookup.value;
    if (!organization) {
      const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      return { success: false, nextResponse: res };
    }
    return successResult({
      data: {
        user: { ...user, role: 'owner' },
        organization,
        access: { kind: 'legacy_admin', role: 'owner' },
      },
    });
  }

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

  if (!user.is_admin) {
    warnInSentry(
      `User ${user.id} attempted to access organization ${organizationId} without sufficient permissions`
    );
    const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    return { success: false, nextResponse: res };
  }

  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    return { success: false, nextResponse: res };
  }

  let access: OrganizationAccess;
  try {
    access = await resolveOrganizationAccess(
      {
        user,
        tokenSource,
        internalApiUse,
        trpcType: requestMethod,
        auditSurface: surface ?? 'rest',
        auditMethod: requestMethod,
        delegatedWorkload: cloudAgentAuthority !== undefined,
      },
      organizationId,
      {
        roles,
        surface: (surface ?? 'rest') as SupportSurface,
        supportKey: options.supportKey ?? null,
        requiredActionClass: options.requiredActionClass,
        auditReason: 'organization_access_rest',
        membershipRows: memberRows,
        organizationIsLive: true,
      }
    );
  } catch (accessError) {
    if (accessError instanceof TRPCError) {
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
        };
      }
      if (supportReason !== null) {
        return {
          success: false,
          nextResponse: NextResponse.json(
            { error: 'Support access required', code: supportReason },
            { status: 403 }
          ),
        };
      }
      const res = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      return { success: false, nextResponse: res };
    }
    throw accessError;
  }

  return successResult({
    data: {
      user: { ...user, role: roleForAccess(access, surface, options.supportKey) },
      organization,
      access,
    },
  });
}

function supportAccessReasonFromError(error: TRPCError): string | null {
  const cause = error.cause;
  if (cause === null || typeof cause !== 'object') return null;
  const reason = (cause as { supportAccessReason?: unknown }).supportAccessReason;
  return typeof reason === 'string' ? reason : null;
}

function roleForAccess(
  access: OrganizationAccess,
  surface: AdminAccessSurface | undefined,
  supportKey: string | null | undefined
): OrganizationRole {
  if (access.kind === 'member' || access.kind === 'legacy_admin') return access.role;
  const entry =
    supportKey === null || supportKey === undefined
      ? undefined
      : findSupportAllowEntry({
          surface: (surface ?? 'rest') as SupportSurface,
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
  roles?: OrganizationRole[],
  options: Omit<Parameters<typeof getAuthorizedOrgContext>[2], 'supportKey'> = {}
) {
  return getAuthorizedOrgContext(id, roles, { ...options, supportKey });
}
