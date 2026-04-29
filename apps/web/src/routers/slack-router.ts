import 'server-only';
import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as slackService from '@/lib/integrations/slack-service';
import { createOAuthState } from '@/lib/integrations/oauth-state';
import { TRPCError } from '@trpc/server';
import {
  resolveOwner,
  resolveAuthorizedOwner,
  optionalOrgInput,
} from '@/lib/integrations/resolve-owner';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { unlinkTeamKiloUsers } from '@/lib/bot-identity';

async function getInitializedBot() {
  const { bot } = await import('@/lib/bot');
  await bot.initialize();
  return bot;
}

async function deleteChatSdkSlackInstallation(teamId: string): Promise<void> {
  const bot = await getInitializedBot();
  await bot.getAdapter('slack').deleteInstallation(teamId);
}

async function deleteChatSdkSlackIdentityCache(teamId: string): Promise<void> {
  const bot = await getInitializedBot();
  await unlinkTeamKiloUsers(bot.getState(), 'slack', teamId);
}

export const slackRouter = createTRPCRouter({
  // Get Slack installation status
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await slackService.getInstallation(owner);

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
        teamId: integration.platform_account_id,
        teamName: integration.platform_account_login,
        scopes: integration.scopes,
        missingScopes: slackService.getMissingSlackScopes(integration.scopes),
        installedAt: integration.installed_at,
        modelSlug: metadata?.model_slug || null,
      },
    };
  }),

  // Get OAuth URL for initiating Slack OAuth flow
  getOAuthUrl: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const statePrefix = input?.organizationId
      ? `org_${input.organizationId}`
      : `user_${ctx.user.id}`;
    const state = createOAuthState(statePrefix, ctx.user.id);
    return {
      url: slackService.getSlackOAuthUrl(state),
    };
  }),

  // Uninstall Slack integration
  uninstallApp: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
      await requireActiveSubscriptionOrTrial(input.organizationId);
    }
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const result = await slackService.uninstallApp(owner, {
      deleteChatSdkInstallation: deleteChatSdkSlackInstallation,
      deleteChatSdkIdentityCache: deleteChatSdkSlackIdentityCache,
    });

    if (input?.organizationId) {
      await createAuditLog({
        organization_id: input.organizationId,
        action: 'organization.settings.change',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        message: 'Disconnected Slack integration',
      });
    }

    return result;
  }),

  // Test Slack connection
  testConnection: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
      await requireActiveSubscriptionOrTrial(input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    return slackService.testConnection(owner);
  }),

  // Update the model for Slack integration
  updateModel: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        modelSlug: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
        await requireActiveSubscriptionOrTrial(input.organizationId);
      }
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const result = await slackService.updateModel(owner, input.modelSlug);

      if (input.organizationId) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated Slack integration model to ${input.modelSlug}`,
        });
      }

      return result;
    }),

  // Dev-only: Remove only the database row without revoking the Slack token
  devRemoveDbRowOnly: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (process.env.NODE_ENV !== 'development') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This endpoint is only available in development mode',
      });
    }
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
      await requireActiveSubscriptionOrTrial(input.organizationId);
    }
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    return slackService.removeDbRowOnly(owner);
  }),
});
