import 'server-only';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import * as forgejoService from '@/lib/integrations/forgejo-service';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import {
  resolveOwner,
  resolveAuthorizedOwner,
  optionalOrgInput,
} from '@/lib/integrations/resolve-owner';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';
import {
  getIntegrationForOwner,
  updateIntegrationMetadataForOwner,
} from '@/lib/integrations/db/platform-integrations';
import {
  getForgejoIntegration,
  getValidForgejoProjectAccessToken,
} from '@/lib/integrations/forgejo-service';
import { validateForgejoInstance } from '@/lib/integrations/platforms/forgejo/adapter';
import { PLATFORM } from '@/lib/integrations/core/constants';

export const forgejoRouter = createTRPCRouter({
  /**
   * Gets Forgejo installation status.
   * Works for both user and org contexts via optional organizationId.
   */
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await forgejoService.getForgejoIntegration(owner);

    if (!integration) {
      return {
        installed: false,
        installation: null,
      };
    }

    const metadata = integration.metadata as {
      forgejo_instance_url?: string;
      token_expires_at?: string;
      auth_type?: 'oauth';
    } | null;

    const isInstalled = isPlatformIntegrationHealthy(integration);

    return {
      installed: isInstalled,
      installation: {
        id: integration.id,
        accountId: integration.platform_account_id,
        accountLogin: integration.platform_account_login,
        instanceUrl: metadata?.forgejo_instance_url || 'https://codeberg.org',
        repositories: requireNumericPlatformRepositories(integration.repositories),
        repositoriesSyncedAt: integration.repositories_synced_at,
        installedAt: integration.installed_at,
        tokenExpiresAt: metadata?.token_expires_at ?? null,
        authType: metadata?.auth_type ?? 'oauth',
      },
    };
  }),

  /**
   * Disconnects Forgejo integration.
   * Works for both user and org contexts via optional organizationId.
   */
  disconnect: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const integration = await forgejoService.getForgejoIntegration(owner);

    if (!integration) {
      return { success: false, message: 'Integration not found' };
    }

    return forgejoService.disconnectForgejoIntegration(owner);
  }),

  refreshRepositories: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        integrationId: z.uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);

      const result = await forgejoService.listForgejoRepositories(
        owner,
        input.integrationId,
        {
          userId: ctx.user.id,
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        },
        true
      );

      return {
        success: true,
        repositoryCount: result.repositories.length,
        syncedAt: result.syncedAt,
      };
    }),

  listRepositories: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        integrationId: z.uuid(),
        forceRefresh: z.boolean().optional().default(false),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return forgejoService.listForgejoRepositories(
        owner,
        input.integrationId,
        {
          userId: ctx.user.id,
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        },
        input.forceRefresh
      );
    }),

  listBranches: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        integrationId: z.uuid(),
        repoPath: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return forgejoService.listForgejoBranches(
        owner,
        input.integrationId,
        {
          userId: ctx.user.id,
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        },
        input.repoPath
      );
    }),

  /**
   * Validates that a URL points to a valid Forgejo instance.
   * Used to verify self-hosted Forgejo URLs before OAuth setup.
   */
  validateInstance: baseProcedure
    .input(
      z.object({
        instanceUrl: z.string().url(),
      })
    )
    .mutation(async ({ input }) => {
      return validateForgejoInstance(input.instanceUrl);
    }),
});
