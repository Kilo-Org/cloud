import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import * as githubAppsService from '@/lib/integrations/github-apps-service';
import {
  findIntegrationByInstallationId,
  getIntegrationForOwner,
  getGitHubIntegrationById,
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
import { APP_URL } from '@/lib/constants';
import {
  getGitHubAppCredentials,
  getGitHubAppTypeForOrganization,
} from '@/lib/integrations/platforms/github/app-selector';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';
import {
  GitHubInstallationSettingsSchema,
  GitHubRepositorySettingsSchema,
} from '@/lib/integrations/github-repository-settings';
import { createGitHubUserAuthorizationState } from '@/lib/integrations/platforms/github/user-authorization-state';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import {
  canManageOrganization,
  canManageOrganizationBilling,
  ORGANIZATION_MANAGE_ROLES,
} from '@kilocode/app-shared/organizations';
import {
  disconnectGitHubUserAuthorization,
  getGitHubUserAuthorizationStatus,
} from '@/lib/integrations/platforms/github/user-authorization';
import { seedUserGithubToken } from '@/lib/github-pr-review/dev-seed';
import { createInstallState } from '@/lib/integrations/github/install-state';
import {
  canOrganizationCreateSharedGitHubConnection,
  canOrganizationUseMultipleGitHubInstallations,
  isGitHubConnectionManagementEnabled,
} from '@/lib/integrations/github/multiple-installations';
import {
  createGitHubConnectionAttempt,
  getGitHubConnectionAttempt,
  selectGitHubConnectionInstallation,
} from '@/lib/integrations/github/connection-service';
import { createGitHubConnectionOAuthState } from '@/lib/integrations/github/connection-state';
import {
  bindGitHubIntegrationToCanonicalInstallation,
  disconnectGitHubInstallation,
  observeGitHubInstallationLifecycle,
} from '@/lib/integrations/db/github-installations';

export const githubAppsRouter = createTRPCRouter({
  disconnectConnection: baseProcedure
    .input(z.object({ organizationId: z.string().uuid(), integrationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!isGitHubConnectionManagementEnabled())
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'GitHub connection management is not available yet',
        });
      const owner = await resolveAuthorizedOwner(
        ctx,
        input.organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      await disconnectGitHubInstallation(owner, input.integrationId);
      return { success: true };
    }),
  getConnectionAttempt: baseProcedure
    .input(z.object({ attemptId: z.string().uuid(), organizationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      if (!isGitHubConnectionManagementEnabled())
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'GitHub connection management disabled',
        });
      await resolveAuthorizedOwner(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      const attempt = await getGitHubConnectionAttempt(input.attemptId, ctx.user.id);
      if (!attempt || attempt.ownerType !== 'org' || attempt.ownerId !== input.organizationId)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'GitHub connection attempt not found' });
      return attempt;
    }),
  beginConnection: baseProcedure
    .input(z.object({ organizationId: z.string().uuid(), returnTo: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!isGitHubConnectionManagementEnabled())
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'GitHub connection management is not available yet',
        });
      const owner = await resolveAuthorizedOwner(
        ctx,
        input.organizationId,
        ORGANIZATION_MANAGE_ROLES
      );
      const githubAppType = await getGitHubAppTypeForOrganization(owner.id);
      const attemptId = await createGitHubConnectionAttempt({
        kiloUserId: ctx.user.id,
        owner,
        githubAppType,
        returnTo: input.returnTo ?? null,
      });
      const oauth = await createGitHubConnectionOAuthState({
        attemptId,
        userId: ctx.user.id,
        stage: 'discover',
      });
      const credentials = getGitHubAppCredentials(githubAppType);
      if (!credentials.clientId)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'GitHub App is not configured',
        });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set(
        'redirect_uri',
        new URL('/api/integrations/github/connection/callback', APP_URL).toString()
      );
      url.searchParams.set('state', oauth.state);
      url.searchParams.set('code_challenge', oauth.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { authorizationUrl: url.toString() };
    }),
  selectConnectionInstallation: baseProcedure
    .input(z.object({ attemptId: z.string().uuid(), installationId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      if (!isGitHubConnectionManagementEnabled())
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'GitHub connection management is not available yet',
        });
      const attempt = await selectGitHubConnectionInstallation({ ...input, userId: ctx.user.id });
      if (!attempt)
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'GitHub connection selection is no longer valid',
        });
      const oauth = await createGitHubConnectionOAuthState({
        attemptId: attempt.id,
        userId: ctx.user.id,
        stage: 'confirm',
        selectedInstallationId: input.installationId,
      });
      const credentials = getGitHubAppCredentials(attempt.github_app_type);
      if (!credentials.clientId)
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'GitHub App is not configured',
        });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set(
        'redirect_uri',
        new URL('/api/integrations/github/connection/callback', APP_URL).toString()
      );
      url.searchParams.set('state', oauth.state);
      url.searchParams.set('code_challenge', oauth.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return { authorizationUrl: url.toString() };
    }),
  // List all integrations
  listIntegrations: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
    return githubAppsService.listIntegrations(owner);
  }),

  listOrganizationInstallations: baseProcedure
    .input(z.object({ organizationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      const integrations = await githubAppsService.listIntegrations({
        type: 'org',
        id: input.organizationId,
      });
      // A locally disconnected connection has already relinquished its slot:
      // it must not keep counting toward "this org already has an
      // installation" cardinality checks, or the org would be unable to add
      // or connect anything else after disconnecting.
      const activeIntegrationCount = integrations.filter(
        integration => !integration.github_disconnected_at
      ).length;
      const primaryId = integrations.find(isPlatformIntegrationHealthy)?.id ?? null;
      const canManageModel = canManageOrganizationBilling(role);
      const canManageConnections =
        canManageOrganization(role) && isGitHubConnectionManagementEnabled();
      const sharingApproved = canOrganizationCreateSharedGitHubConnection(input.organizationId);
      const multipleInstallationsApproved =
        activeIntegrationCount === 0 ||
        canOrganizationUseMultipleGitHubInstallations(input.organizationId);
      const existingConnectionAdmission = !canManageConnections
        ? { allowed: false as const, reason: 'not_authorized' as const }
        : !sharingApproved
          ? { allowed: false as const, reason: 'sharing_not_approved' as const }
          : !multipleInstallationsApproved
            ? { allowed: false as const, reason: 'multiple_installations_not_approved' as const }
            : { allowed: true as const, reason: null };

      return {
        connectionManagementEnabled: isGitHubConnectionManagementEnabled(),
        canConnectExisting: existingConnectionAdmission.allowed,
        existingConnectionAdmission,
        canAdd: canManageOrganization(role) && multipleInstallationsApproved,
        installations: integrations.map(integration => {
          const repositories = requireNumericPlatformRepositories(integration.repositories) ?? [];
          const status: 'connected' | 'disconnected' | 'pending' | 'suspended' | 'needs_attention' =
            integration.github_disconnected_at
              ? 'disconnected'
              : isPlatformIntegrationHealthy(integration)
                ? 'connected'
                : integration.integration_status === 'pending'
                  ? 'pending'
                  : integration.suspended_at || integration.integration_status === 'suspended'
                    ? 'suspended'
                    : 'needs_attention';
          const canCancel =
            status === 'pending' &&
            (ctx.user.is_admin ||
              role === 'owner' ||
              role === 'admin' ||
              integration.kilo_requester_user_id === ctx.user.id);
          const metadata = integration.metadata as Record<string, unknown> | null;

          return {
            id: integration.id,
            accountLogin: integration.platform_account_login,
            installationId: integration.platform_installation_id,
            status,
            repositorySelection: integration.repository_access,
            repositories,
            isPrimary: integration.id === primaryId,
            canRefresh: status === 'connected' || status === 'needs_attention',
            canUninstall: ctx.user.is_admin || role === 'owner' || role === 'admin',
            canCancel,
            modelSlug: (metadata?.model_slug as string) || null,
            canManageModel,
          };
        }),
      };
    }),

  getUserAuthorization: baseProcedure.query(async ({ ctx }) => {
    return getGitHubUserAuthorizationStatus(ctx.user.id);
  }),

  connectUserAuthorization: baseProcedure.mutation(async ({ ctx }) => {
    const authorization = await getGitHubUserAuthorizationStatus(ctx.user.id);
    if (authorization.connected) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Disconnect your current GitHub identity before connecting another account',
      });
    }
    const credentials = getGitHubAppCredentials('standard');
    if (!credentials.clientId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'GitHub App is not configured',
      });
    }
    const { state, codeChallenge } = await createGitHubUserAuthorizationState(ctx.user.id);
    const authorizeUrl = new URL('https://github.com/login/oauth/authorize');
    authorizeUrl.searchParams.set('client_id', credentials.clientId);
    authorizeUrl.searchParams.set(
      'redirect_uri',
      new URL('/api/integrations/github/user-connect/callback', APP_URL).toString()
    );
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    return { authorizationUrl: authorizeUrl.toString() };
  }),

  disconnectUserAuthorization: baseProcedure.mutation(async ({ ctx }) => {
    await disconnectGitHubUserAuthorization(ctx.user.id);
    return { success: true };
  }),

  getAppType: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    return getGitHubAppTypeForOrganization(input?.organizationId ?? null);
  }),

  // Mint a one-time install state token for the signed-in user.
  mintInstallState: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        returnTo: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await resolveAuthorizedOwner(
        ctx,
        input.organizationId,
        input.organizationId ? ORGANIZATION_MANAGE_ROLES : undefined
      );
      if (owner.type === 'org' && !canOrganizationUseMultipleGitHubInstallations(owner.id)) {
        const integrations = await githubAppsService.listIntegrations(owner);
        // A locally disconnected connection has relinquished its slot and
        // must not block starting a fresh installation.
        const hasActiveIntegration = integrations.some(
          integration => !integration.github_disconnected_at
        );
        if (hasActiveIntegration) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'This organization already has a GitHub installation',
          });
        }
      }
      const appType = await getGitHubAppTypeForOrganization(input.organizationId ?? null);

      const token = await createInstallState({
        kiloUserId: ctx.user.id,
        ownerType: owner.type,
        ownerId: owner.id,
        githubAppType: appType,
        returnTo: input.returnTo ?? null,
      });

      return { token };
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
    const isInstalled = isPlatformIntegrationHealthy(integration);

    return {
      installed: isInstalled,
      installation: {
        id: integration.id,
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
        repositories: requireNumericPlatformRepositories(integration.repositories),
        suspendedAt: integration.suspended_at,
        suspendedBy: integration.suspended_by,
        installedAt: integration.installed_at,
        status,
        modelSlug: (metadata?.model_slug as string) || null,
      },
    };
  }),

  // Update the model for GitHub App integration
  updateModel: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        integrationId: z.string().uuid().optional(),
        modelSlug: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const result = await githubAppsService.updateModel(
        owner,
        input.modelSlug,
        input.integrationId
      );

      if (input.organizationId && result.success) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: input.integrationId
            ? `Updated GitHub App installation ${input.integrationId} model to ${input.modelSlug}`
            : `Updated GitHub App integration model to ${input.modelSlug}`,
        });
      }

      return result;
    }),

  // Get an installation's default bot-mention model and PR review mode, plus
  // every accessible repository's raw override (or `null`, meaning it inherits
  // the default). Used to render and edit repository customizations.
  getRepositoryCustomizations: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        integrationId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return githubAppsService.getRepositoryCustomizations(owner, input.integrationId);
    }),

  // Update an installation's default bot-mention model and/or PR review mode.
  updateInstallationSettings: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        integrationId: z.string().uuid(),
        settings: GitHubInstallationSettingsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const result = await githubAppsService.updateInstallationSettings(
        owner,
        input.integrationId,
        input.settings
      );

      if (input.organizationId && result.success) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated GitHub App installation ${input.integrationId} default settings: ${JSON.stringify(input.settings)}`,
        });
      }

      return result;
    }),

  // Set or clear a per-repository override. A `null` field explicitly
  // restores inheritance from the installation default; an omitted field is
  // left untouched.
  updateRepositorySettings: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
        integrationId: z.string().uuid(),
        repositoryId: z.number().int().positive(),
        settings: GitHubRepositorySettingsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = await resolveAuthorizedOwner(ctx, input.organizationId);
      const result = await githubAppsService.updateRepositorySettings(
        owner,
        input.integrationId,
        input.repositoryId,
        input.settings
      );

      if (input.organizationId && result.success) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated GitHub App installation ${input.integrationId} repository ${input.repositoryId} settings: ${JSON.stringify(input.settings)}`,
        });
      }

      return result;
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
  uninstallApp: baseProcedure
    .input(
      z
        .object({
          organizationId: z.string().uuid().optional(),
          integrationId: z.string().uuid().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const owner = await resolveAuthorizedOwner(
        ctx,
        input?.organizationId,
        input?.organizationId ? ORGANIZATION_MANAGE_ROLES : undefined
      );
      if (input?.organizationId && !input.integrationId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Integration ID is required' });
      }
      const result = await githubAppsService.uninstallApp(
        owner,
        input?.integrationId,
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
          message: `Uninstalled Kilo GitHub App installation ${input.integrationId}`,
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
    .input(
      z
        .object({
          organizationId: z.string().uuid().optional(),
          integrationId: z.string().uuid().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      let role: Awaited<ReturnType<typeof ensureOrganizationAccess>> | null = null;
      if (input?.organizationId) {
        role = await ensureOrganizationAccess(ctx, input.organizationId);
        if (!input.integrationId) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Integration ID is required' });
        }
      }
      const owner = resolveOwner(ctx, input?.organizationId);
      if (input?.integrationId) {
        const integration = await getGitHubIntegrationById(owner, input.integrationId);
        if (!integration) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Pending installation not found' });
        }
        const canCancel =
          !input.organizationId ||
          ctx.user.is_admin ||
          role === 'owner' ||
          role === 'admin' ||
          integration.kilo_requester_user_id === ctx.user.id;
        if (!canCancel) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Cannot cancel this request' });
        }
      }
      const result = await githubAppsService.cancelPendingInstallation(owner, input?.integrationId);

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
  refreshInstallation: baseProcedure
    .input(
      z
        .object({
          organizationId: z.string().uuid().optional(),
          integrationId: z.string().uuid().optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      if (input?.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input?.organizationId);

      if (input?.organizationId && !input.integrationId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Integration ID is required' });
      }
      const integration = input?.integrationId
        ? await getGitHubIntegrationById(owner, input.integrationId)
        : await getIntegrationForOwner(owner, 'github');
      if (!integration || !integration.platform_installation_id) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No GitHub integration found',
        });
      }

      const installationId = integration.platform_installation_id;
      const appType = integration.github_app_type || 'standard';

      const installationDetails = await fetchGitHubInstallationDetails(installationId, appType);
      if (!installationDetails.account.id || !installationDetails.account.login) {
        throw new TRPCError({
          code: 'BAD_GATEWAY',
          message: 'GitHub installation account identity unavailable',
        });
      }

      await observeGitHubInstallationLifecycle({
        installationId,
        appType,
        state: 'active',
        accountId: installationDetails.account.id.toString(),
        accountLogin: installationDetails.account.login,
        accountType: installationDetails.account.type === 'Organization' ? 'Organization' : 'User',
        permissions: installationDetails.permissions,
        scopes: installationDetails.events,
        repositoryAccess: installationDetails.repository_selection,
      });
      await bindGitHubIntegrationToCanonicalInstallation({
        integrationId: integration.id,
        installationId,
        appType,
      });
      const repositories = await fetchGitHubRepositories(installationId, appType, integration.id);
      await updateRepositoriesForIntegration(integration.id, repositories);

      if (input?.organizationId) {
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Refreshed GitHub App installation ${integration.id}`,
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

      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_MANAGE_ROLES);
      }

      const appType = input.appType;
      const installationDetails = await fetchGitHubInstallationDetails(
        input.installationId,
        appType
      );

      const owner = resolveOwner(ctx, input.organizationId);

      const devUpsertResult = await upsertPlatformIntegrationForOwner(owner, {
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

      if (!devUpsertResult.ok) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'This GitHub installation is already claimed by another account.',
        });
      }

      const integration = await findIntegrationByInstallationId(
        'github',
        input.installationId,
        appType
      );
      const belongsToOwner =
        integration &&
        ((owner.type === 'org' && integration.owned_by_organization_id === owner.id) ||
          (owner.type === 'user' && integration.owned_by_user_id === owner.id));
      if (integration && belongsToOwner) {
        const repositories = await fetchGitHubRepositories(input.installationId, appType);
        await updateRepositoriesForIntegration(integration.id, repositories);
      }

      return { success: true };
    }),

  // Dev-only: seed the user's `user_github_app_tokens` row with a FAKE token
  // so the E2E suite can hit the local mock GitHub without a real OAuth
  // round-trip. Encryption uses the same public-key envelope the real
  // `exchangeAndStoreGitHubUserAuthorization` path uses, so the seeded row is
  // decryptable by the production token client.
  devSeedUserGithubToken: baseProcedure
    .input(
      z.object({
        token: z.string().min(1),
        githubLogin: z.string().min(1),
        githubUserId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (process.env.NODE_ENV !== 'development') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This endpoint is only available in development mode',
        });
      }
      const result = await seedUserGithubToken({
        kiloUserId: ctx.user.id,
        token: input.token,
        githubLogin: input.githubLogin,
        githubUserId: input.githubUserId,
      });
      return { success: result.upserted, githubLogin: result.githubLogin };
    }),
});
