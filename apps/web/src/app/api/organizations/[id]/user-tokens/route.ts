import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { generateOrganizationApiToken } from '@/lib/tokens';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import {
  createDelegatedResourceToken,
  isDelegableResource,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';
import { isSharedResourceTokenIssuanceEnabled } from '@/lib/config.server';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;

  // Verify user has access to the organization (any member role is sufficient)
  const result = await getAuthorizedOrgContext(organizationId);

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
  if (resource !== undefined) {
    if (!isSharedResourceTokenIssuanceEnabled()) {
      return NextResponse.json(
        { error: 'Shared resource token migration is unavailable' },
        { status: 503 }
      );
    }
    if (user.role === 'billing_manager' || (resource === 'attribution' && user.role === 'admin')) {
      return NextResponse.json(
        { error: 'Organization role cannot issue this resource token' },
        { status: 403 }
      );
    }
    const organizationRole = user.role;
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
        message: `Resource token generated for organization ${organization.name}`,
      });
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

  const { token, expiresAt } = generateOrganizationApiToken(user, organizationId, user.role);

  // Log the token generation for audit purposes
  await createAuditLog({
    organization_id: organizationId,
    action: 'organization.token.generate',
    actor_name: user.google_user_name,
    actor_email: user.google_user_email,
    actor_id: user.id,
    message: `User token generated for organization ${organization.name}`,
  });

  return NextResponse.json({
    token,
    expiresAt,
    organizationId,
  });
}
