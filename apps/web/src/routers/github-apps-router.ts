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
import { db } from '@/lib/drizzle';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { eq, and } from 'drizzle-orm';
import { createOAuthState } from '@/lib/integrations/platforms/github/oauth-state';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';
import { APP_URL } from '@/lib/constants';
import { ENABLE_GITHUB_USER_TOKENS, USER_GH_APP_TOKEN_ENCRYPTION_KEY } from '@/lib/config.server';
import { decryptWithSymmetricKey } from '@/lib/encryption';

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

  // Connect the current user's GitHub identity for user-to-server tokens
  connectUserIdentity: baseProcedure
    .input(
      z.object({
        appType: z.enum(['standard', 'lite']).optional().default('standard'),
        returnTo: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ENABLE_GITHUB_USER_TOKENS) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'GitHub user token connect is not enabled',
        });
      }

      if (input.appType === 'lite') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Lite app does not support user identity connect',
        });
      }

      const credentials = getGitHubAppCredentials(input.appType);
      const state = createOAuthState({
        kilo_user_id: ctx.user.id,
        app_type: input.appType,
        return_to: input.returnTo,
      });

      const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
      authorizeUrl.searchParams.set('client_id', credentials.clientId);
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set(
        'redirect_uri',
        `${APP_URL}/api/integrations/github/user-connect/callback`
      );

      return { authorizeUrl: authorizeUrl.toString() };
    }),

  // Get the current user's GitHub connection status (no token returned)
  getUserConnectionStatus: baseProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        github_login: user_github_app_tokens.github_login,
        github_user_id: user_github_app_tokens.github_user_id,
        revoked_at: user_github_app_tokens.revoked_at,
        access_token_expires_at: user_github_app_tokens.access_token_expires_at,
      })
      .from(user_github_app_tokens)
      .where(
        and(
          eq(user_github_app_tokens.kilo_user_id, ctx.user.id),
          eq(user_github_app_tokens.github_app_type, 'standard')
        )
      );

    const row = rows[0];
    if (!row) {
      return { connected: false as const, login: undefined, githubUserId: undefined };
    }

    const now = new Date();
    const isRevoked = row.revoked_at !== null;
    const isExpired =
      row.access_token_expires_at !== null && new Date(row.access_token_expires_at) <= now;

    if (isRevoked || isExpired) {
      return {
        connected: false as const,
        login: row.github_login,
        githubUserId: row.github_user_id,
      };
    }

    return {
      connected: true as const,
      login: row.github_login,
      githubUserId: row.github_user_id,
    };
  }),

  // Disconnect the current user's GitHub identity
  disconnectUserIdentity: baseProcedure.mutation(async ({ ctx }) => {
    const rows = await db
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.kilo_user_id, ctx.user.id));

    for (const row of rows) {
      try {
        const credentials = getGitHubAppCredentials(row.github_app_type);
        const token = decryptWithSymmetricKey(
          row.access_token_encrypted,
          USER_GH_APP_TOKEN_ENCRYPTION_KEY
        );

        // Revoke the authorization on GitHub's side using Basic auth
        const auth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
          'base64'
        );
        const response = await fetch(
          `https://api.github.com/applications/${credentials.clientId}/grant`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/json',
              Accept: 'application/vnd.github+json',
            },
            body: JSON.stringify({ access_token: token }),
          }
        );

        if (!response.ok && response.status !== 404 && response.status !== 422) {
          console.error('Failed to revoke GitHub authorization:', {
            status: response.status,
          });
        }
      } catch (error) {
        console.error('Error revoking GitHub authorization:', error);
        // Continue to delete the local row regardless
      }
    }

    await db
      .delete(user_github_app_tokens)
      .where(eq(user_github_app_tokens.kilo_user_id, ctx.user.id));

    return { ok: true };
  }),
});
