import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import * as gitlabService from '@/lib/integrations/gitlab-service';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  resolveOwner,
  resolveAuthorizedOwner,
  optionalOrgInput,
} from '@/lib/integrations/resolve-owner';
import { validateGitLabInstance } from '@/lib/integrations/platforms/gitlab/adapter';
import { validatePersonalAccessToken } from '@/lib/integrations/platforms/gitlab/adapter';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';
import {
  getIntegrationForOwner,
  updateIntegrationMetadataForOwner,
} from '@/lib/integrations/db/platform-integrations';
import {
  syncWebhooksForRepositories,
  type ConfiguredWebhook,
} from '@/lib/integrations/platforms/gitlab/webhook-sync';
import { logExceptInTest } from '@/lib/utils.server';
import { randomBytes } from 'node:crypto';

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
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId, ORGANIZATION_BILLING_ROLES);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return gitlabService.connectWithPAT(owner, input.token, input.instanceUrl, ctx.user.id);
    }),

  /**
   * Gets GitLab installation status.
   * Works for both user and org contexts via optional organizationId.
   */
  getInstallation: baseProcedure.input(optionalOrgInput).query(async ({ ctx, input }) => {
    if (input?.organizationId) {
      await ensureOrganizationAccess(ctx, input.organizationId);
    }
    const owner = resolveOwner(ctx, input?.organizationId);
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

    const isInstalled = isPlatformIntegrationHealthy(integration);

    return {
      installed: isInstalled,
      installation: {
        id: integration.id,
        accountId: integration.platform_account_id,
        accountLogin: integration.platform_account_login,
        instanceUrl: metadata?.gitlab_instance_url || 'https://gitlab.com',
        repositories: requireNumericPlatformRepositories(integration.repositories),
        repositoriesSyncedAt: integration.repositories_synced_at,
        installedAt: integration.installed_at,
        tokenExpiresAt: metadata?.token_expires_at ?? null,
        authType: metadata?.auth_type ?? 'oauth',
      },
    };
  }),

  /**
   * Disconnects GitLab integration.
   * Works for both user and org contexts via optional organizationId.
   */
  disconnect: baseProcedure.input(optionalOrgInput).mutation(async ({ ctx, input }) => {
    const owner = await resolveAuthorizedOwner(ctx, input?.organizationId);
    const integration = await gitlabService.getGitLabIntegration(owner);

    if (!integration) {
      return { success: false, message: 'Integration not found' };
    }

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
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);

      const result = await gitlabService.listGitLabRepositories(
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
      return gitlabService.listGitLabRepositories(
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
        projectPath: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const owner = resolveOwner(ctx, input.organizationId);
      return gitlabService.listGitLabBranches(
        owner,
        input.integrationId,
        {
          userId: ctx.user.id,
          ...(input.organizationId ? { organizationId: input.organizationId } : {}),
        },
        input.projectPath
      );
    }),

  // Personal/self-only GitLab webhook secret rotation. The secret is
  // returned ONCE on success and never re-fetched from status — status
  // no longer carries it (see P1-D-32). Org rotation goes through the
  // dedicated billing-gated `organizations.reviewAgent.rotateGitLabWebhookSecret`
  // mutation; this endpoint is the caller's own personal integration
  // only, and re-syncs the Kilo-managed webhooks so the integration
  // keeps working after the secret change.
  regenerateWebhookSecret: baseProcedure.mutation(async ({ ctx }) => {
    // Self-only: resolve the caller's own owner directly. The org
    // surface uses `organizations.reviewAgent.rotateGitLabWebhookSecret`
    // with `organizationBillingMutationProcedure` gating.
    const owner = { type: 'user' as const, id: ctx.user.id };

    // Generate the new secret here so we can re-sync the Kilo-managed
    // webhooks against the SAME secret in a single operation. The
    // underlying service-level regen would leave the live webhooks
    // carrying the old secret, breaking the integration.
    const newSecret = randomBytes(32).toString('hex');

    const integration = await getIntegrationForOwner(owner, 'gitlab');
    if (!integration) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'GitLab integration not found',
      });
    }

    const existingMetadata = (integration.metadata || {}) as Record<string, unknown>;
    const configuredWebhooks =
      (existingMetadata.configured_webhooks as Record<string, ConfiguredWebhook> | undefined) ?? {};
    const instanceUrl =
      (existingMetadata.gitlab_instance_url as string | undefined) || 'https://gitlab.com';

    // No Kilo-managed webhooks → skip the network round-trip and just
    // persist + return the new secret for manual reconfiguration.
    if (Object.keys(configuredWebhooks).length === 0) {
      await updateIntegrationMetadataForOwner(owner, 'gitlab', {
        ...existingMetadata,
        webhook_secret: newSecret,
      });
      return {
        webhookSecret: newSecret,
        webhookSync: {
          created: 0,
          updated: 0,
          deleted: 0,
          errors: [] as Array<{ projectId: number; error: string; operation: string }>,
        },
        configuredWebhookCount: 0,
      };
    }

    let webhookSyncResult: {
      created: number;
      updated: number;
      deleted: number;
      errors: Array<{ projectId: number; error: string; operation: string }>;
    } = { created: 0, updated: 0, deleted: 0, errors: [] };
    let updatedWebhooks: Record<string, ConfiguredWebhook> = configuredWebhooks;

    try {
      const accessToken = await getValidGitLabToken(integration, { userId: ctx.user.id });
      const configuredRepoIds = Object.keys(configuredWebhooks)
        .map(id => Number.parseInt(id, 10))
        .filter(id => Number.isFinite(id));

      // previous=[] → every currently-configured repo is treated as
      // "added" by the sync helper, so the existing Kilo webhook is
      // UPDATED in place with the new secret (nothing is deleted).
      const syncOutcome = await syncWebhooksForRepositories(
        accessToken,
        newSecret,
        configuredRepoIds,
        [],
        configuredWebhooks,
        instanceUrl
      );
      updatedWebhooks = syncOutcome.updatedWebhooks;
      webhookSyncResult = {
        created: syncOutcome.result.created.length,
        updated: syncOutcome.result.updated.length,
        deleted: syncOutcome.result.deleted.length,
        errors: syncOutcome.result.errors,
      };
      logExceptInTest('[gitlab.regenerateWebhookSecret] Webhook re-sync completed', {
        created: webhookSyncResult.created,
        updated: webhookSyncResult.updated,
        deleted: webhookSyncResult.deleted,
        errorCount: webhookSyncResult.errors.length,
      });
    } catch (webhookError) {
      // Re-sync failure MUST NOT lose the new secret: persist it
      // anyway so the operator can recover via manual reconfiguration.
      logExceptInTest('[gitlab.regenerateWebhookSecret] Webhook re-sync failed', {
        error: webhookError instanceof Error ? webhookError.message : String(webhookError),
      });
      webhookSyncResult = {
        created: 0,
        updated: 0,
        deleted: 0,
        errors: [
          {
            projectId: 0,
            error: webhookError instanceof Error ? webhookError.message : 'Unknown error',
            operation: 'create',
          },
        ],
      };
    }

    await updateIntegrationMetadataForOwner(owner, 'gitlab', {
      ...existingMetadata,
      webhook_secret: newSecret,
      configured_webhooks: updatedWebhooks,
    });

    return {
      webhookSecret: newSecret,
      webhookSync: webhookSyncResult,
      configuredWebhookCount: Object.keys(updatedWebhooks).length,
    };
  }),
});
