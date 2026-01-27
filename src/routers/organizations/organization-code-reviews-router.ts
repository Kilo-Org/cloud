import { createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  organizationMemberProcedure,
  organizationOwnerProcedure,
  OrganizationIdInputSchema,
} from './utils';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import {
  getAgentConfig,
  upsertAgentConfig,
  setAgentEnabled,
} from '@/lib/agent-config/db/agent-configs';

import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { fetchGitHubRepositoriesForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import { fetchGitLabRepositoriesForOrganization } from '@/lib/cloud-agent/gitlab-integration-helpers';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/models';
import { PLATFORM } from '@/lib/integrations/core/constants';

const PlatformSchema = z.enum(['github', 'gitlab']).default('github');

const ManuallyAddedRepositoryInputSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

const SaveReviewConfigInputSchema = OrganizationIdInputSchema.extend({
  platform: PlatformSchema,
  reviewStyle: z.enum(['strict', 'balanced', 'lenient']),
  focusAreas: z.array(z.string()),
  customInstructions: z.string().optional(),
  maxReviewTimeMinutes: z.number().min(5).max(30),
  modelSlug: z.string(),
  repositorySelectionMode: z.enum(['all', 'selected']).optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
  manuallyAddedRepositories: z.array(ManuallyAddedRepositoryInputSchema).optional(),
});

export const organizationReviewAgentRouter = createTRPCRouter({
  /**
   * Gets the GitHub App installation status
   * (Replaces getGitHubStatus - now checks for GitHub App instead of OAuth)
   */
  getGitHubStatus: organizationMemberProcedure.query(async ({ input }) => {
    const integration = await getIntegrationForOrganization(input.organizationId, 'github');

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
   * List GitHub repositories accessible by the organization's GitHub integration
   */
  listGitHubRepositories: organizationMemberProcedure
    .input(
      OrganizationIdInputSchema.extend({
        forceRefresh: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input }) => {
      return await fetchGitHubRepositoriesForOrganization(input.organizationId, input.forceRefresh);
    }),

  /**
   * Gets the GitLab OAuth integration status for organization
   */
  getGitLabStatus: organizationMemberProcedure.query(async ({ input }) => {
    const integration = await getIntegrationForOrganization(input.organizationId, PLATFORM.GITLAB);

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
   * List GitLab repositories accessible by the organization's GitLab integration
   */
  listGitLabRepositories: organizationMemberProcedure
    .input(
      OrganizationIdInputSchema.extend({
        forceRefresh: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input }) => {
      return await fetchGitLabRepositoriesForOrganization(input.organizationId, input.forceRefresh);
    }),

  /**
   * Gets the review agent configuration
   */
  getReviewConfig: organizationMemberProcedure
    .input(OrganizationIdInputSchema.extend({ platform: PlatformSchema }))
    .query(async ({ input }) => {
      const platform = input.platform ?? 'github';
      const config = await getAgentConfig(input.organizationId, 'code_review', platform);

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
   * Saves the review agent configuration
   */
  saveReviewConfig: organizationOwnerProcedure
    .input(SaveReviewConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const platform = input.platform ?? 'github';

        await upsertAgentConfig({
          organizationId: input.organizationId,
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

        // Audit log
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated Review Agent configuration for ${platform} (style: ${input.reviewStyle})`,
        });

        return { success: true };
      } catch (error) {
        console.error('Error saving review config:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to save review configuration',
        });
      }
    }),

  /**
   * Toggles the review agent on/off
   */
  toggleReviewAgent: organizationOwnerProcedure
    .input(
      OrganizationIdInputSchema.extend({
        platform: PlatformSchema,
        isEnabled: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const platform = input.platform ?? 'github';

        await setAgentEnabled(input.organizationId, 'code_review', platform, input.isEnabled);

        // Audit log
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `${input.isEnabled ? 'Enabled' : 'Disabled'} AI Code Review Agent for ${platform}`,
        });

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
