import 'server-only';

import { z } from 'zod';
import {
  disconnectBitbucketOAuthIntegration,
  getBitbucketOAuthIntegrationStatus,
  selectBitbucketOAuthWorkspace,
} from '@/lib/integrations/platforms/bitbucket/oauth-integration';
import {
  optionalOrgInput,
  resolveAuthorizedOwner,
  resolveOwner,
} from '@/lib/integrations/resolve-owner';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

const SelectWorkspaceInputSchema = z
  .object({
    organizationId: z.uuid().optional(),
    workspaceUuid: z.string().min(1),
    workspaceSlug: z.string().min(1),
  })
  .strict();

export const bitbucketRouter = createTRPCRouter({
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    let canManage = true;
    if (input?.organizationId) {
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      canManage = role === 'owner' || role === 'billing_manager';
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const status = await getBitbucketOAuthIntegrationStatus(owner, canManage);
    if (!status) return { status: 'not_connected' as const, canManage };

    if (
      status.status === 'reconnect_required' &&
      'authorizingNickname' in status &&
      status.authorizingNickname
    ) {
      return {
        status: 'reconnect_required' as const,
        authorizingNickname: status.authorizingNickname,
        canManage,
      };
    }
    if (status.status === 'reconnect_required') {
      return { status: 'reconnect_required' as const, canManage };
    }
    if (status.status === 'workspace_selection_required') {
      if (!canManage) {
        return { status: 'workspace_selection_required' as const, canManage: false as const };
      }
      return {
        status: 'workspace_selection_required' as const,
        authorizingNickname: status.authorizingNickname,
        availableWorkspaces: status.availableWorkspaces,
        canManage: true as const,
      };
    }
    if (status.status === 'connected') {
      return {
        status: 'connected' as const,
        authorizingNickname: status.authorizingNickname,
        workspace: status.workspace
          ? {
              uuid: status.workspace.uuid,
              slug: status.workspace.slug,
              name: status.workspace.displayName,
            }
          : undefined,
        canManage,
      };
    }
    return { status: 'reconnect_required' as const, canManage };
  }),

  selectWorkspace: baseProcedure
    .input(SelectWorkspaceInputSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      return selectBitbucketOAuthWorkspace({
        owner,
        kiloUserId: ctx.user.id,
        workspaceUuid: input.workspaceUuid,
        workspaceSlug: input.workspaceSlug,
      });
    }),

  disconnect: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    await disconnectBitbucketOAuthIntegration({ owner });
    return { success: true };
  }),
});
