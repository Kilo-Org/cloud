import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import * as githubAppsService from '@/lib/integrations/github-apps-service';
import {
  getIntegrationForOwner,
  upsertPlatformIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import {
  fetchGitHubInstallationDetails,
  fetchGitHubRepositories,
} from '@/lib/integrations/platforms/github/adapter';
import { TRPCError } from '@trpc/server';
import {
  resolveOwner,
  resolveAuthorizedOwner,
  optionalOrgInput,
} from '@/lib/integrations/resolve-owner';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';

export const githubAppsRouter = createTRPCRouter({
  // List all integrations
  listIntegrations: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    return githubAppsService.listIntegrations(owner);
  }),

  // Get GitHub App installation status
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    const integration = await githubAppsService.getInstallation(owner);

    if (!integration) {
      return {
        installed: false,
        installation: null,
      };
    }

    const metadata = integration.metadata as Record<string, unknown> | null;
    const pendingApproval = metadata?.pending_approval as Record<string, unknown> | undefined;
    const status = (pendingApproval?.status as string) || null;
    const isInstalled = integration.integration_status === 'active';

    return {
      installed: isInstalled,
      installation: {
        installationId: integration.platform_installation_id,
        accountId: integration.platform_account_id,
        accountLogin: integration.platform_account_login,
        accountType: (integration.permissions as unknown as Record<string, unknown>)
          ?.account_type as string | undefined,
        targetType: (integration.permissions as unknown as Record<string, unknown>)?.target_type as
          | string
          | undefined,
        permissions: integration.permissions,
        events: integration.scopes,
        repositorySelection: integration.repository_access,
        repositories: integration.repositories,
        suspendedAt: integration.suspended_at,
        suspendedBy: integration.suspended_by,
        installedAt: integration.installed_at,
        status,
      },
    };
  }),

  // Check if current user has a pending installation.
  // Note: This is intentionally user-scoped (ctx.user.id) even when an organizationId is
  // provided, because GitHub App installations are initiated per-user. The org access
  // check only gates visibility — the pending state itself is always user-global.
  checkUserPendingInstallation: baseProcedure
    .input(optionalOrgInput)
    .query(async ({ ctx, input }) => {
      if (input?.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const pendingInstallation = await githubAppsService.checkUserPendingInstallation(ctx.user.id);

      if (!pendingInstallation) {
        return {
          hasPending: false,
          pendingOrganizationId: null,
        };
      }

      return {
        hasPending: true,
        pendingOrganizationId: pendingInstallation.owned_by_organization_id,
      };
    }),

  // Uninstall GitHub App
  uninstallApp: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const result = await githubAppsService.uninstallApp(
      owner,
      ctx.user.id,
      ctx.user.google_user_email,
      ctx.user.google_user_name
    );

    if (input?.organizationId) {
      await createAuditLog({
        organization_id: input.organizationId,
        action: 'organization.settings.change',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        message: 'Uninstalled Kilo GitHub App',
      });
    }

    return result;
  }),

  // List repositories accessible by an integration
  listRepositories: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        integrationId: z.string().uuid(),
        forceRefresh: z.boolean().optional().default(false),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return githubAppsService.listRepositories(owner, input.integrationId, input.forceRefresh);
    }),

  // List branches for a repository
  listBranches: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        integrationId: z.string().uuid(),
        repositoryFullName: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return githubAppsService.listBranches(owner, input.integrationId, input.repositoryFullName);
    }),

  // Cancel pending installation
  cancelPendingInstallation: baseProcedure
    .input(optionalOrgInput)
    .mutation(async ({ ctx, input }) => {
      if (input?.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input?.organizationId);
      const result = await githubAppsService.cancelPendingInstallation(owner);

      if (input?.organizationId) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: 'Cancelled pending GitHub App installation request',
        });
      }

      return result;
    }),

  // Refresh installation details from GitHub (permissions, events, repositories)
  refreshInstallation: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);

    const integration = await getIntegrationForOwner(owner, 'github');
    if (!integration || !integration.platform_installation_id) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'No GitHub integration found',
      });
    }

    const installationId = integration.platform_installation_id;
    const appType = integration.github_app_type || 'standard';

    const installationDetails = await fetchGitHubInstallationDetails(installationId, appType);

    await upsertPlatformIntegrationForOwner(owner, {
      platform: 'github',
      integrationType: 'app',
      platformInstallationId: installationId,
      platformAccountId: installationDetails.account.id.toString(),
      platformAccountLogin: integration.platform_account_login ?? undefined,
      permissions: installationDetails.permissions,
      scopes: installationDetails.events,
      repositoryAccess: installationDetails.repository_selection,
      installedAt: installationDetails.created_at,
    });

    const repositories = await fetchGitHubRepositories(installationId, appType);
    await updateRepositoriesForIntegration(integration.id, repositories);

    if (input?.organizationId) {
      await createAuditLog({
        organization_id: input.organizationId,
        action: 'organization.settings.change',
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        message: 'Refreshed GitHub App installation details',
      });
    }

    return { success: true };
  }),

  // Dev-only: Add an existing GitHub installation manually
  devAddInstallation: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        installationId: z.string().min(1),
        accountLogin: z.string().min(1),
        appType: z.enum(['standard', 'lite']).optional().default('standard'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (process.env.NODE_ENV !== 'development') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint is only available in development mode',
        });
      }

      const appType = input.appType;
      const installationDetails = await fetchGitHubInstallationDetails(
        input.installationId,
        appType
      );

      const owner = resolveOwner(ctx, input.organizationId);

      await upsertPlatformIntegrationForOwner(owner, {
        platform: 'github',
        integrationType: 'app',
        platformInstallationId: input.installationId,
        platformAccountId: installationDetails.account.id.toString(),
        platformAccountLogin: input.accountLogin,
        permissions: installationDetails.permissions,
        scopes: installationDetails.events,
        repositoryAccess: installationDetails.repository_selection,
        installedAt: installationDetails.created_at,
        githubAppType: appType,
      });

      const integration = await getIntegrationForOwner(owner, 'github');
      if (integration) {
        const repositories = await fetchGitHubRepositories(input.installationId, appType);
        await updateRepositoriesForIntegration(integration.id, repositories);
      }

      return { success: true };
    }),
});
