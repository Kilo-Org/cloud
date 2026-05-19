import 'server-only';
import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as teamsService from '@/lib/integrations/teams-service';
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
import { PLATFORM } from '@/lib/integrations/core/constants';

async function getInitializedBot() {
  const { bot } = await import('@/lib/bot');
  await bot.initialize();
  return bot;
}

async function deleteChatSdkTeamsIdentityCache(tenantId: string): Promise<void> {
  const bot = await getInitializedBot();
  await unlinkTeamKiloUsers(bot.getState(), PLATFORM.TEAMS, tenantId);
}

export const teamsRouter = createTRPCRouter({
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await teamsService.getInstallation(owner);

    if (!integration) {
      return { installed: false, installation: null };
    }

    const isInstalled = integration.integration_status === 'active';
    const metadata = integration.metadata as { model_slug?: string } | null;

    return {
      installed: isInstalled,
      installation: {
        tenantId: integration.platform_installation_id,
        tenantName: integration.platform_account_login,
        status: integration.integration_status,
        suspendedAt: integration.suspended_at,
        suspendedBy: integration.suspended_by,
        scopes: integration.scopes,
        installedAt: integration.installed_at,
        modelSlug: metadata?.model_slug || null,
      },
    };
  }),

  getSetupInfo: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    return teamsService.getTeamsSetupInfo();
  }),

  uninstallApp: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const result = await teamsService.uninstallApp(owner, {
      deleteChatSdkIdentityCache: deleteChatSdkTeamsIdentityCache,
    });

    if (input?.organizationId) {
      await createAuditLog({
        organization_id: input.organizationId,
        action: 'organization.settings.change',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        message: 'Disconnected Teams integration',
      });
    }

    return result;
  }),

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
      const result = await teamsService.updateModel(owner, input.modelSlug);

      if (input.organizationId) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated Teams integration model to ${input.modelSlug}`,
        });
      }

      return result;
    }),

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
    return teamsService.removeDbRowOnly(owner);
  }),
});
