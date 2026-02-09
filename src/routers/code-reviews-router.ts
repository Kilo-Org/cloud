import { createTRPCRouter, baseProcedure } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  getIntegrationForOwner,
  updateIntegrationMetadataForOwner,
} from '@/lib/integrations/db/platform-integrations';
import {
  getAgentConfigForOwner,
  upsertAgentConfigForOwner,
  setAgentEnabledForOwner,
} from '@/lib/agent-config/db/agent-configs';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { fetchGitHubRepositoriesForUser } from '@/lib/cloud-agent/github-integration-helpers';
import {
  fetchGitLabRepositoriesForUser,
  searchGitLabRepositoriesForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/models';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  syncWebhooksForRepositories,
  type ConfiguredWebhook,
} from '@/lib/integrations/platforms/gitlab/webhook-sync';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { logExceptInTest } from '@/lib/utils.server';

const PlatformSchema = z.enum(['github', 'gitlab']).default('github');

const ManuallyAddedRepositoryInputSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

const SaveReviewConfigInputSchema = z.object({
  platform: PlatformSchema,
  reviewStyle: z.enum(['strict', 'balanced', 'lenient']),
  focusAreas: z.array(z.string()),
  customInstructions: z.string().optional(),
  maxReviewTimeMinutes: z.number().min(5).max(30),
  modelSlug: z.string(),
  repositorySelectionMode: z.enum(['all', 'selected']).optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
  manuallyAddedRepositories: z.array(ManuallyAddedRepositoryInputSchema).optional(),
  // GitLab-specific: auto-configure webhooks
  autoConfigureWebhooks: z.boolean().optional().default(true),
});

export const personalReviewAgentRouter = createTRPCRouter({
  /**
   * Gets the GitHub App installation status for personal user
   */
  getGitHubStatus: baseProcedure.query(async ({ ctx }) => {
    const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
    const integration = await getIntegrationForOwner(owner, 'github');

    if (!integration || integration.integration_status !== 'active') {
      return {
        connected: false,
        integration: null,
      };
    }

    return {
      connected: true,
      integration: {
        accountLogin: integration.platform_account_login,
        repositorySelection: integration.repository_access,
        installedAt: integration.installed_at,
        isValid: !integration.suspended_at,
      },
    };
  }),

  /**
   * List GitHub repositories accessible by the user's personal GitHub integration
   */
  listGitHubRepositories: baseProcedure
    .input(z.object({ forceRefresh: z.boolean().optional().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      return await fetchGitHubRepositoriesForUser(ctx.user.id, input?.forceRefresh ?? false);
    }),

  /**
   * Gets the GitLab OAuth integration status for personal user
   */
  getGitLabStatus: baseProcedure.query(async ({ ctx }) => {
    const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
    const integration = await getIntegrationForOwner(owner, PLATFORM.GITLAB);

    if (!integration || integration.integration_status !== 'active') {
      return {
        connected: false,
        integration: null,
      };
    }

    // Extract webhook secret from metadata for display
    const metadata = integration.metadata as Record<string, unknown> | null;
    const webhookSecret = metadata?.webhook_secret as string | undefined;

    return {
      connected: true,
      integration: {
        accountLogin: integration.platform_account_login,
        repositorySelection: integration.repository_access,
        installedAt: integration.installed_at,
        isValid: true, // GitLab OAuth doesn't have suspension concept
        webhookSecret, // Include webhook secret for user to configure in GitLab
        instanceUrl: (metadata?.gitlab_instance_url as string) || 'https://gitlab.com',
      },
    };
  }),

  /**
   * List GitLab repositories accessible by the user's personal GitLab integration
   */
  listGitLabRepositories: baseProcedure
    .input(z.object({ forceRefresh: z.boolean().optional().default(false) }).optional())
    .query(async ({ ctx, input }) => {
      return await fetchGitLabRepositoriesForUser(ctx.user.id, input?.forceRefresh ?? false);
    }),

  /**
   * Search GitLab repositories by query string
   * Used when users have 100+ repositories and need to find specific ones
   */
  searchGitLabRepositories: baseProcedure
    .input(z.object({ query: z.string().min(2) }))
    .query(async ({ ctx, input }) => {
      return await searchGitLabRepositoriesForUser(ctx.user.id, input.query);
    }),

  /**
   * Gets the review agent configuration for personal user
   */
  getReviewConfig: baseProcedure
    .input(z.object({ platform: PlatformSchema }).optional())
    .query(async ({ ctx, input }) => {
      const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
      const platform = input?.platform ?? 'github';
      const config = await getAgentConfigForOwner(owner, 'code_review', platform);

      if (!config) {
        // Return default configuration
        return {
          isEnabled: false,
          reviewStyle: 'balanced' as const,
          focusAreas: [],
          customInstructions: null,
          maxReviewTimeMinutes: 10,
          modelSlug: PRIMARY_DEFAULT_MODEL,
          repositorySelectionMode: 'all' as const,
          selectedRepositoryIds: [],
          manuallyAddedRepositories: [],
        };
      }

      const cfg = config.config as CodeReviewAgentConfig;
      return {
        isEnabled: config.is_enabled,
        reviewStyle: cfg.review_style || 'balanced',
        focusAreas: cfg.focus_areas || [],
        customInstructions: cfg.custom_instructions || null,
        maxReviewTimeMinutes: cfg.max_review_time_minutes || 10,
        modelSlug: cfg.model_slug || PRIMARY_DEFAULT_MODEL,
        repositorySelectionMode: cfg.repository_selection_mode || 'all',
        selectedRepositoryIds: cfg.selected_repository_ids || [],
        manuallyAddedRepositories: cfg.manually_added_repositories || [],
      };
    }),

  /**
   * Saves the review agent configuration for personal user
   * For GitLab: optionally syncs webhooks for selected repositories
   */
  saveReviewConfig: baseProcedure
    .input(SaveReviewConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
        const platform = input.platform ?? 'github';

        // Get previous config to determine which repos were previously selected
        const previousConfig = await getAgentConfigForOwner(owner, 'code_review', platform);
        const previousRepoIds =
          (previousConfig?.config as CodeReviewAgentConfig | undefined)?.selected_repository_ids ||
          [];

        // Save the agent config
        await upsertAgentConfigForOwner({
          owner,
          agentType: 'code_review',
          platform,
          config: {
            review_style: input.reviewStyle,
            focus_areas: input.focusAreas,
            custom_instructions: input.customInstructions || null,
            max_review_time_minutes: input.maxReviewTimeMinutes,
            model_slug: input.modelSlug,
            repository_selection_mode: input.repositorySelectionMode || 'all',
            selected_repository_ids: input.selectedRepositoryIds || [],
            manually_added_repositories: input.manuallyAddedRepositories || [],
          },
          createdBy: ctx.user.id,
        });

        // For GitLab: sync webhooks if auto-configure is enabled
        let webhookSyncResult = null;
        if (
          platform === PLATFORM.GITLAB &&
          input.autoConfigureWebhooks !== false &&
          input.repositorySelectionMode === 'selected'
        ) {
          const integration = await getIntegrationForOwner(owner, PLATFORM.GITLAB);
          if (integration) {
            const metadata = integration.metadata as Record<string, unknown> | null;
            const webhookSecret = metadata?.webhook_secret as string | undefined;
            const instanceUrl =
              (metadata?.gitlab_instance_url as string | undefined) || 'https://gitlab.com';
            const configuredWebhooks =
              (metadata?.configured_webhooks as Record<string, ConfiguredWebhook>) || {};

            if (webhookSecret) {
              try {
                // Get a valid access token (handles refresh if expired)
                const accessToken = await getValidGitLabToken(integration);

                const { result, updatedWebhooks } = await syncWebhooksForRepositories(
                  accessToken,
                  webhookSecret,
                  input.selectedRepositoryIds || [],
                  previousRepoIds,
                  configuredWebhooks,
                  instanceUrl
                );

                // Update integration metadata with new webhook configuration
                await updateIntegrationMetadataForOwner(owner, PLATFORM.GITLAB, {
                  configured_webhooks: updatedWebhooks,
                });

                webhookSyncResult = {
                  created: result.created.length,
                  updated: result.updated.length,
                  deleted: result.deleted.length,
                  errors: result.errors,
                };

                logExceptInTest('[saveReviewConfig] Webhook sync completed', webhookSyncResult);
              } catch (webhookError) {
                // Log but don't fail the config save
                logExceptInTest('[saveReviewConfig] Webhook sync failed', {
                  error:
                    webhookError instanceof Error ? webhookError.message : String(webhookError),
                });
                webhookSyncResult = {
                  created: 0,
                  updated: 0,
                  deleted: 0,
                  errors: [
                    {
                      projectId: 0,
                      error: webhookError instanceof Error ? webhookError.message : 'Unknown error',
                      operation: 'sync' as const,
                    },
                  ],
                };
              }
            }
          }
        }

        return {
          success: true,
          webhookSync: webhookSyncResult,
        };
      } catch (error) {
        console.error('Error saving review config:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save review configuration',
        });
      }
    }),

  /**
   * Toggles the review agent on/off for personal user
   */
  toggleReviewAgent: baseProcedure
    .input(
      z.object({
        platform: PlatformSchema,
        isEnabled: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
        const platform = input.platform ?? 'github';

        await setAgentEnabledForOwner(owner, 'code_review', platform, input.isEnabled);

        return { success: true, isEnabled: input.isEnabled };
      } catch (error) {
        console.error('Error toggling review agent:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to toggle review agent',
        });
      }
    }),
});
