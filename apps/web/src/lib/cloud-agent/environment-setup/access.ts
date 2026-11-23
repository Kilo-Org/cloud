import type { EnvironmentOwner } from '@kilocode/cloud-agent-profile';
import { ORGANIZATION_MANAGE_ROLES } from '@kilocode/app-shared/organizations';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import { getOwner, requireActiveOrganization } from '@/lib/cloud-agent/environment-owner';

export async function requireManageOwner(
  ctx: TRPCContext,
  organizationId?: string
): Promise<EnvironmentOwner> {
  if (organizationId) {
    await ensureOrganizationAccess(ctx, organizationId, ORGANIZATION_MANAGE_ROLES);
    await requireActiveOrganization(organizationId);
  }
  return getOwner(organizationId, ctx.user.id);
}

export async function requireReadOwner(
  ctx: TRPCContext,
  organizationId?: string
): Promise<EnvironmentOwner> {
  if (organizationId) {
    await ensureOrganizationAccess(ctx, organizationId);
    await requireActiveOrganization(organizationId);
  }
  return getOwner(organizationId, ctx.user.id);
}

export type EnvironmentSetupClaim = { runId: string; environmentId: string };

export async function requireAgentScope(
  ctx: TRPCContext,
  runId: string
): Promise<{
  owner: EnvironmentOwner;
  organizationId?: string;
  claim: EnvironmentSetupClaim;
}> {
  const claim = ctx.cloudAgentAuthority?.environmentSetup;
  if (!claim || claim.runId !== runId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Environment setup authority required',
    });
  }

  const organizationId = ctx.cloudAgentAuthority?.organizationId ?? undefined;
  const owner = await requireManageOwner(ctx, organizationId);

  return { owner, organizationId, claim };
}
