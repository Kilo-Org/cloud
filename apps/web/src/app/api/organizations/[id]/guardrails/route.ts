import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import {
  getOrganizationGuardrailsPolicy,
  type OrganizationGuardrailsPolicy,
} from '@/lib/organizations/guardrails/guardrails-policy';

/**
 * The organization's guardrails for its clients to apply: the MCP allow list and enforcement
 * mode, skill guardrails, and whether input scanning is on. Readable by any member, because
 * every member's client needs it. Organizations without AI Guardrails get everything off.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<OrganizationGuardrailsPolicy | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    return nextResponse;
  }

  return NextResponse.json(await getOrganizationGuardrailsPolicy(data.organization));
}
