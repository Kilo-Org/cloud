import 'server-only';
import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as discordService from '@/lib/integrations/discord-service';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { TRPCError } from '@trpc/server';
import {
  resolveOwner,
  resolveAuthorizedOwner,
  optionalOrgInput,
} from '@/lib/integrations/resolve-owner';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';

export const discordRouter = createTRPCRouter({
  // Get Discord installation status
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await discordService.getInstallation(owner);

    if (!integration) {
      return {
        installed: false,
        installation: null,
      };
    }

    const isInstalled = integration.integration_status === 'active';
    const metadata = integration.metadata as { model_slug?: string } | null;

    return {
      installed: isInstalled,
      installation: {
        guildId: integration.platform_account_id,
        guildName: integration.platform_account_login,
        scopes: integration.scopes,
        installedAt: integration.installed_at,
        modelSlug: metadata?.model_slug || null,
      },
    };
  }),

  // Get OAuth URL for initiating Discord OAuth flow
  getOAuthUrl: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const statePrefix = input?.organizationId
      ? `org_${input.organizationId}`
      : `user_${ctx.user.id}`;
    const state = createOAuthState(statePrefix, ctx.user.id);
    return {
      url: discordService.getDiscordOAuthUrl(state),
    };
  }),

  // Uninstall Discord integration
  uninstallApp: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const result = await discordService.uninstallApp(owner);

    if (input?.organizationId) {
      await createAuditLog({
        organization_id: input.organizationId,
        action: 'organization.settings.change',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        message: 'Disconnected Discord integration',
      });
    }

    return result;
  }),

  // Test Discord connection
  testConnection: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    return discordService.testConnection(owner);
  }),

  // Update the model for Discord integration
  updateModel: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        modelSlug: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const result = await discordService.updateModel(owner, input.modelSlug);

      if (input.organizationId && result.success) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated Discord integration model to ${input.modelSlug}`,
        });
      }

      return result;
    }),

  // Dev-only: Remove only the database row without revoking the Discord token
  devRemoveDbRowOnly: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (process.env.NODE_ENV !== 'development') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This endpoint is only available in development mode',
      });
    }
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    return discordService.removeDbRowOnly(owner);
  }),
});
