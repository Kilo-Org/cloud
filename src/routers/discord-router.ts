import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as discordService from '@/lib/integrations/discord-service';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { TRPCError } from '@trpc/server';

export const discordRouter = createTRPCRouter({
  // Get Discord installation status for the current user
  getInstallation: baseProcedure.query(async ({ ctx }) => {
    const integration = await discordService.getInstallation({
      type: 'user',
      id: ctx.user.id,
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

  // Get OAuth URL for initiating Discord OAuth flow
  getOAuthUrl: baseProcedure.query(({ ctx }) => {
    const state = createOAuthState(`user_${ctx.user.id}`, ctx.user.id);
    return {
      url: discordService.getDiscordOAuthUrl(state),
    };
  }),

  // Uninstall Discord integration for the current user
  uninstallApp: baseProcedure.mutation(async ({ ctx }) => {
    return discordService.uninstallApp({ type: 'user', id: ctx.user.id });
  }),

  // Test Discord connection
  testConnection: baseProcedure.mutation(async ({ ctx }) => {
    return discordService.testConnection({ type: 'user', id: ctx.user.id });
  }),

  // Dev-only: Remove only the database row without revoking the Discord token
  devRemoveDbRowOnly: baseProcedure.mutation(async ({ ctx }) => {
    if (process.env.NODE_ENV !== 'development') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This endpoint is only available in development mode',
      });
    }
    return discordService.removeDbRowOnly({ type: 'user', id: ctx.user.id });
  }),
});
