import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { generateOrganizationApiToken } from '@/lib/tokens';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;

  // Verify user has access to the organization (any member role is sufficient)
  const result = await getAuthorizedOrgContext(organizationId);

  if (!result.success) {
    return result.nextResponse;
  }

  const { user, organization } = result.data;

  // Generate the organization-scoped JWT token (15 minute expiration)
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
