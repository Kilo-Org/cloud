import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import * as z from 'zod';
import * as gitlabService from '@/lib/integrations/gitlab-service';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { validateGitLabInstance } from '@/lib/integrations/platforms/gitlab/adapter';
import { validatePersonalAccessToken } from '@/lib/integrations/platforms/gitlab/adapter';

export const gitlabRouter = createTRPCRouter({
  /**
   * Validates that a URL points to a valid GitLab instance.
   * Used to verify self-hosted GitLab URLs before OAuth setup.
   */
  validateInstance: baseProcedure
    .input(
      z.object({
        instanceUrl: z.string().url(),
      })
    )
    .mutation(async ({ input }) => {
      return validateGitLabInstance(input.instanceUrl);
    }),

  /**
   * Validates a Personal Access Token before connecting.
   * Returns token info, user details, and any warnings.
   */
  validatePAT: baseProcedure
    .input(
      z.object({
        token: z.string().min(1, 'Token is required'),
        instanceUrl: z.string().url().optional().default('https://gitlab.com'),
      })
    )
    .mutation(async ({ input }) => {
      return validatePersonalAccessToken(input.token, input.instanceUrl);
    }),

  /**
   * Connects GitLab using a Personal Access Token.
   * Creates or updates the platform_integration record.
   */
  connectWithPAT: baseProcedure
    .input(
      z.object({
        token: z.string().min(1, 'Token is required'),
        instanceUrl: z.string().url().optional().default('https://gitlab.com'),
        organizationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = input.organizationId
        ? { type: 'org' as const, id: input.organizationId }
        : { type: 'user' as const, id: ctx.user.id };

      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'billing_manager']);
      }

      return gitlabService.connectWithPAT(owner, input.token, input.instanceUrl);
    }),

  getInstallation: baseProcedure.query(async ({ ctx }) => {
    const owner = { type: 'user' as const, id: ctx.user.id };
    const integration = await gitlabService.getGitLabIntegration(owner);

    if (!integration) {
      return {
        installed: false,
        installation: null,
      };
    }

    const metadata = integration.metadata as {
      gitlab_instance_url?: string;
      token_expires_at?: string;
      auth_type?: 'oauth' | 'pat';
    } | null;

    const isInstalled = integration.integration_status === 'active';

    return {
      installed: isInstalled,
      installation: {
        id: integration.id,
        accountId: integration.platform_account_id,
        accountLogin: integration.platform_account_login,
        instanceUrl: metadata?.gitlab_instance_url || 'https://gitlab.com',
        repositories: integration.repositories,
        repositoriesSyncedAt: integration.repositories_synced_at,
        installedAt: integration.installed_at,
        tokenExpiresAt: metadata?.token_expires_at ?? null,
        authType: metadata?.auth_type ?? 'oauth',
      },
    };
  }),

  disconnect: baseProcedure.mutation(async ({ ctx }) => {
    const owner = { type: 'user' as const, id: ctx.user.id };
    const integration = await gitlabService.getGitLabIntegration(owner);

    if (!integration) {
      return { success: false, message: 'Integration not found' };
    }

    return gitlabService.disconnectGitLabIntegration(owner);
  }),

  getIntegration: baseProcedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = input.organizationId
        ? { type: 'org' as const, id: input.organizationId }
        : { type: 'user' as const, id: ctx.user.id };

      const integration = await gitlabService.getGitLabIntegration(owner);

      if (!integration) {
        return {
          connected: false,
          integration: null,
        };
      }

      const metadata = integration.metadata as {
        gitlab_instance_url?: string;
        token_expires_at?: string;
        auth_type?: 'oauth' | 'pat';
      } | null;

      return {
        connected: integration.integration_status === 'active',
        integration: {
          id: integration.id,
          accountId: integration.platform_account_id,
          accountLogin: integration.platform_account_login,
          instanceUrl: metadata?.gitlab_instance_url || 'https://gitlab.com',
          repositories: integration.repositories,
          repositoriesSyncedAt: integration.repositories_synced_at,
          installedAt: integration.installed_at,
          tokenExpiresAt: metadata?.token_expires_at,
          authType: metadata?.auth_type ?? 'oauth',
        },
      };
    }),

  disconnectOrg: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'org' as const, id: input.organizationId };
      await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'billing_manager']);

      return gitlabService.disconnectGitLabIntegration(owner);
    }),

  refreshRepositories: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        integrationId: z.uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = input.organizationId
        ? { type: 'org' as const, id: input.organizationId }
        : { type: 'user' as const, id: ctx.user.id };

      const result = await gitlabService.listGitLabRepositories(owner, input.integrationId, true);

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
      const owner = input.organizationId
        ? { type: 'org' as const, id: input.organizationId }
        : { type: 'user' as const, id: ctx.user.id };

      return gitlabService.listGitLabRepositories(owner, input.integrationId, input.forceRefresh);
    }),

  listBranches: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        integrationId: z.uuid(),
        projectPath: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      const owner = input.organizationId
        ? { type: 'org' as const, id: input.organizationId }
        : { type: 'user' as const, id: ctx.user.id };

      return gitlabService.listGitLabBranches(owner, input.integrationId, input.projectPath);
    }),

  regenerateWebhookSecret: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const owner = input.organizationId
        ? { type: 'org' as const, id: input.organizationId }
        : { type: 'user' as const, id: ctx.user.id };

      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ['owner', 'billing_manager']);
      }

      return gitlabService.regenerateWebhookSecret(owner);
    }),
});
