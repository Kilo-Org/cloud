import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { generateOrganizationApiToken } from '@/lib/auth/kilo-token-signing';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import {
  canIssueLegacyOrganizationToken,
  createDelegatedResourceToken,
  isDelegableResource,
  isPagesResource,
  TypedResourceDelegationError,
  type DelegableResource,
} from '@/lib/auth/resource-delegation';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import { isResourceTokenIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
import {
  addAdminAuditMetadata,
  adminActionContextFromHeaders,
  runElevatedOrganizationWrite,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';

// Roles that may mint each token kind without the admin bypass, mirroring the
// role checks below (which never fire for admins, who are forced to owner).
function rolesAllowedToMint(resource: DelegableResource | undefined): OrganizationRole[] {
  if (resource === undefined) return ['owner', 'admin', 'billing_manager', 'member'];
  if (resource === 'attribution') return ['owner', 'member'];
  return ['owner', 'admin', 'member'];
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;

  // Verify user has access to the organization (any member role is sufficient)
  const result = await getAuthorizedOrgContext(organizationId, undefined, {
    requestMethod: request.method,
  });

  if (!result.success) {
    return result.nextResponse;
  }

  const { user, organization } = result.data;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const resource =
    body && typeof body === 'object' ? (body as { resource?: unknown }).resource : undefined;
  if (resource !== undefined && !isDelegableResource(resource)) {
    return NextResponse.json({ error: 'Unsupported resource' }, { status: 400 });
  }
  // A token minted by a Kilo admin whose own role would not allow it is
  // recorded, refusals included.
  return runElevatedOrganizationWrite(
    adminActionContextFromHeaders(user, request.headers),
    {
      organizationId,
      requiredRoles: rolesAllowedToMint(resource),
      action: 'organization.token.mint',
      message: 'Minted organization-scoped token',
    },
    async () => {
      if (resource !== undefined && isPagesResource(resource)) {
        return NextResponse.json(
          { error: 'Organization credentials cannot mint Pages tokens' },
          { status: 403 }
        );
      }
      if (resource !== undefined) {
        if (!isResourceTokenIssuanceEnabled('delegated-resource')) {
          return NextResponse.json(
            { error: 'Shared resource token migration is unavailable' },
            { status: 503 }
          );
        }
        if (
          user.role === 'billing_manager' ||
          (resource === 'attribution' && user.role === 'admin')
        ) {
          return NextResponse.json(
            { error: 'Organization role cannot issue this resource token' },
            { status: 403 }
          );
        }
        const organizationRole = user.role;
        addAdminAuditMetadata({ tokenKind: 'resource', resource, organizationRole });
        try {
          const delegated = await createDelegatedResourceToken(user, resource, {
            headers: request.headers,
            organizationRole,
            organizationId,
          });
          await createAuditLog({
            organization_id: organizationId,
            action: 'organization.token.generate',
            actor_name: user.google_user_name,
            actor_email: user.google_user_email,
            actor_id: user.id,
            details: { id: 'token.resource' },
            message: `Resource token generated for organization ${organization.name}`,
          });
          addAdminAuditMetadata({ expiresAt: delegated.expiresAt });
          return NextResponse.json({
            token: delegated.token,
            expiresAt: delegated.expiresAt,
            organizationId,
          });
        } catch (error) {
          if (error instanceof TypedResourceDelegationError) {
            return NextResponse.json({ error: error.message }, { status: error.status });
          }
          throw error;
        }
      }

      addAdminAuditMetadata({ tokenKind: 'legacy', organizationRole: user.role });
      if (!(await canIssueLegacyOrganizationToken(request.headers, user))) {
        return NextResponse.json(
          { error: 'This credential cannot issue a legacy organization token' },
          { status: 403 }
        );
      }

      const { token, expiresAt } = generateOrganizationApiToken(user, organizationId, user.role);

      // Log the token generation for audit purposes
      await createAuditLog({
        organization_id: organizationId,
        action: 'organization.token.generate',
        actor_name: user.google_user_name,
        actor_email: user.google_user_email,
        actor_id: user.id,
        details: { id: 'token.user' },
        message: `User token generated for organization ${organization.name}`,
      });
      addAdminAuditMetadata({ expiresAt });

      return NextResponse.json({
        token,
        expiresAt,
        organizationId,
      });
    }
  );
}
