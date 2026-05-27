import 'server-only';
import { z } from 'zod';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as linearService from '@/lib/integrations/linear-service';
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

// Dynamic import to avoid a circular dependency with @/lib/bot (which imports
// the bot-platform registry, which imports this router's service layer).
async function getInitializedBot() {
  const { bot } = await import('@/lib/bot');
  await bot.initialize();
  return bot;
}

async function getChatSdkLinearAccessToken(organizationId: string): Promise<string | null> {
  const bot = await getInitializedBot();
  const installation = await bot.getAdapter('linear').getInstallation(organizationId);
  return installation?.accessToken ?? null;
}

async function deleteChatSdkLinearInstallation(organizationId: string): Promise<void> {
  const bot = await getInitializedBot();
  await bot.getAdapter('linear').deleteInstallation(organizationId);
}

async function deleteChatSdkLinearIdentityCache(organizationId: string): Promise<void> {
  const bot = await getInitializedBot();
  await unlinkTeamKiloUsers(bot.getState(), PLATFORM.LINEAR, organizationId);
}

export const linearRouter = createTRPCRouter({
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await linearService.getInstallation(owner);

    if (!integration) {
      return { installed: false, installation: null };
    }

    const isInstalled = integration.integration_status === 'active';
    const metadata = integration.metadata as { model_slug?: string } | null;

    return {
      installed: isInstalled,
      installation: {
        organizationId: integration.platform_installation_id,
        workspaceName: integration.platform_account_login,
        status: integration.integration_status,
        suspendedAt: integration.suspended_at,
        suspendedBy: integration.suspended_by,
        scopes: integration.scopes,
        installedAt: integration.installed_at,
        modelSlug: metadata?.model_slug || null,
      },
    };
  }),

  uninstallApp: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const result = await linearService.uninstallApp(owner, {
      getChatSdkAccessToken: getChatSdkLinearAccessToken,
      deleteChatSdkInstallation: deleteChatSdkLinearInstallation,
      deleteChatSdkIdentityCache: deleteChatSdkLinearIdentityCache,
    });

    if (input?.organizationId) {
      await createAuditLog({
        organization_id: input.organizationId,
        action: 'organization.settings.change',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        message: 'Disconnected Linear integration',
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
      const result = await linearService.updateModel(owner, input.modelSlug);

      if (input.organizationId) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated Linear integration model to ${input.modelSlug}`,
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
    return linearService.removeDbRowOnly(owner);
  }),
});
