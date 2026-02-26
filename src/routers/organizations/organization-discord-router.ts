import { createTRPCRouter } from '@/lib/trpc/init';
import { organizationMemberProcedure, organizationOwnerProcedure } from './utils';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import * as discordService from '@/lib/integrations/discord-service';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { TRPCError } from '@trpc/server';

export const organizationDiscordRouter = createTRPCRouter({
  /**
   * Gets the Discord installation status for an organization
   */
  getInstallation: organizationMemberProcedure.query(async ({ input }) => {
    const integration = await discordService.getInstallation({
      type: 'org',
      id: input.organizationId,
    });

    if (!integration) {
      return {
        installed: false,
        installation: null,
      };
    }

    // Only return installed: true if the integration status is 'active'
    const isInstalled = integration.integration_status === 'active';

    return {
      installed: isInstalled,
      installation: {
        guildId: integration.platform_account_id,
        guildName: integration.platform_account_login,
        scopes: integration.scopes,
        installedAt: integration.installed_at,
      },
    };
  }),

  /**
   * Get OAuth URL for initiating Discord OAuth flow
   */
  getOAuthUrl: organizationMemberProcedure.query(({ input, ctx }) => {
    const state = createOAuthState(`org_${input.organizationId}`, ctx.user.id);
    return {
      url: discordService.getDiscordOAuthUrl(state),
    };
  }),

  /**
   * Uninstalls the Discord integration for an organization
   */
  uninstallApp: organizationOwnerProcedure.mutation(async ({ input, ctx }) => {
    const result = await discordService.uninstallApp({
      type: 'org',
      id: input.organizationId,
    });

    // Audit log
    await createAuditLog({
      organization_id: input.organizationId,
      action: 'organization.settings.change',
      actor_id: ctx.user.id,
      actor_email: ctx.user.google_user_email,
      actor_name: ctx.user.google_user_name,
      message: 'Disconnected Discord integration',
    });

    return result;
  }),

  /**
   * Test Discord connection
   */
  testConnection: organizationMemberProcedure.mutation(async ({ input }) => {
    return discordService.testConnection({ type: 'org', id: input.organizationId });
  }),

  /**
   * Dev-only: Remove only the database row without revoking the Discord token
   */
  devRemoveDbRowOnly: organizationOwnerProcedure.mutation(async ({ input }) => {
    if (process.env.NODE_ENV !== 'development') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This endpoint is only available in development mode',
      });
    }
    return discordService.removeDbRowOnly({ type: 'org', id: input.organizationId });
  }),
});
