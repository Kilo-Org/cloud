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
import type { CodeReviewAgentConfig, RepositoryModelOverride } from '@/lib/agent-config/core/types';
import { fetchGitHubRepositoriesForUser } from '@/lib/cloud-agent/github-integration-helpers';
import { fetchGitLabRepositoriesForUser } from '@/lib/cloud-agent/gitlab-integration-helpers';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  syncWebhooksForRepositories,
  type ConfiguredWebhook,
} from '@/lib/integrations/platforms/gitlab/webhook-sync';
import { getValidGitLabToken } from '@/lib/integrations/gitlab-service';
import { logExceptInTest } from '@/lib/utils.server';
import {
  clearCodeReviewActionRequiredState,
  getCodeReviewActionRequiredState,
} from '@/lib/code-reviews/action-required';
import { getReviewMemoryEnabledFromConfig } from '@/lib/code-reviews/review-memory/settings';
import {
  createManualCodeReviewJob,
  ManualCodeReviewJobInputSchema,
} from '@/lib/code-reviews/manual-code-review-jobs';
import {
  applyCodeReviewConfigPatch,
  type CodeReviewFieldMergePatch,
  type CodeReviewStoredConfig,
} from '@kilocode/app-shared/code-review';

const PlatformSchema = z.enum(['github', 'gitlab']).default('github');

const ManuallyAddedRepositoryInputSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

// Personal integrations are GitHub/GitLab only, so override repo IDs are numeric.
const RepositoryModelOverrideInputSchema = z.object({
  repositoryId: z.number(),
  repoFullName: z.string().max(511),
  // Keep in sync with RepositoryModelOverrideSchema.model_slug (canonical storage),
  // so an over-long slug is rejected at save time rather than failing the config's
  // canonical parse on read.
  modelSlug: z.string().max(512),
  thinkingEffort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
});

// Bound the overrides array so a caller cannot grow the JSONB config unbounded, and
// reject duplicate entries for the same repo (by id or full name) — dispatch resolves
// via first-match, so duplicates would silently pick one. Mirrors the duplicate
// rejection already applied to Bitbucket selectedRepositoryIds.
const MAX_REPOSITORY_MODEL_OVERRIDES = 1000;

function rejectDuplicateRepositoryModelOverrides(
  overrides: Array<{ repositoryId: number | string; repoFullName: string }>,
  ctx: z.RefinementCtx
) {
  const seenIds = new Set<number | string>();
  const seenNames = new Set<string>();
  for (const override of overrides) {
    if (seenIds.has(override.repositoryId) || seenNames.has(override.repoFullName)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate repository model override for the same repository',
      });
      return;
    }
    seenIds.add(override.repositoryId);
    seenNames.add(override.repoFullName);
  }
}

const SaveReviewConfigInputSchema = z.object({
  platform: PlatformSchema,
  reviewStyle: z.enum(['strict', 'balanced', 'lenient', 'roast']),
  focusAreas: z.array(z.string()),
  customInstructions: z.string().optional(),
  modelSlug: z.string(),
  thinkingEffort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
  repositorySelectionMode: z.enum(['all', 'selected']).optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
  manuallyAddedRepositories: z.array(ManuallyAddedRepositoryInputSchema).optional(),
  repositoryModelOverrides: z
    .array(RepositoryModelOverrideInputSchema)
    .max(MAX_REPOSITORY_MODEL_OVERRIDES)
    .superRefine(rejectDuplicateRepositoryModelOverrides)
    .optional(),
  disableReviewMd: z.boolean().optional(),
  gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
  // GitLab-specific: auto-configure webhooks
  autoConfigureWebhooks: z.boolean().optional().default(true),
});

// Field-merge PATCH schema for personal users. Strict subset of
// SaveReviewConfigInputSchema: every field is optional (omission = preserve
// stored value), no defaults. Mobile uses this for partial updates; web forms
// stay on the full save. Reuses the same per-field bounds as
// SaveReviewConfigInputSchema so a partial update can't smuggle in values
// that the full save would reject.
const PatchReviewConfigInputSchema = z.object({
  platform: PlatformSchema,
  reviewStyle: z.enum(['strict', 'balanced', 'lenient', 'roast']).optional(),
  focusAreas: z.array(z.string()).optional(),
  customInstructions: z.string().optional(),
  modelSlug: z.string().optional(),
  thinkingEffort: z
    .string()
    .max(50)
    .regex(/^[a-zA-Z]+$/)
    .nullable()
    .optional(),
  repositorySelectionMode: z.enum(['all', 'selected']).optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
  manuallyAddedRepositories: z.array(ManuallyAddedRepositoryInputSchema).optional(),
  repositoryModelOverrides: z
    .array(RepositoryModelOverrideInputSchema)
    .max(MAX_REPOSITORY_MODEL_OVERRIDES)
    .superRefine(rejectDuplicateRepositoryModelOverrides)
    .optional(),
  disableReviewMd: z.boolean().optional(),
  gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
  // GitLab-specific: auto-configure webhooks. Only consulted when
  // `selectedRepositoryIds` is also present in the patch (we only re-sync
  // webhooks in that case, matching the full-save gating).
  autoConfigureWebhooks: z.boolean().optional(),
});

export const personalReviewAgentRouter = createTRPCRouter({
  createManualReviewJob: baseProcedure
    .input(ManualCodeReviewJobInputSchema)
    .mutation(async ({ ctx, input }) => {
      const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
      return await createManualCodeReviewJob({ owner, input });
    }),

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
          modelSlug: PRIMARY_DEFAULT_MODEL,
          thinkingEffort: null satisfies string | null,
          gateThreshold: 'off' as const,
          repositorySelectionMode: 'all' as const,
          selectedRepositoryIds: [],
          manuallyAddedRepositories: [],
          repositoryModelOverrides: [],
          council: null,
          councilEnabledRepositoryIds: [],
          disableReviewMd: true,
          reviewMemoryEnabled: false,
          actionRequired: null,
        };
      }

      const cfg = config.config as CodeReviewAgentConfig;
      return {
        isEnabled: config.is_enabled,
        reviewStyle: cfg.review_style || 'balanced',
        focusAreas: cfg.focus_areas || [],
        customInstructions: cfg.custom_instructions || null,
        modelSlug: cfg.model_slug || PRIMARY_DEFAULT_MODEL,
        thinkingEffort: cfg.thinking_effort ?? null,
        gateThreshold: cfg.gate_threshold ?? 'off',
        repositorySelectionMode: cfg.repository_selection_mode || 'all',
        selectedRepositoryIds: (cfg.selected_repository_ids ?? []).filter(
          (repositoryId): repositoryId is number => typeof repositoryId === 'number'
        ),
        manuallyAddedRepositories: cfg.manually_added_repositories || [],
        repositoryModelOverrides: (cfg.repository_model_overrides ?? [])
          .filter(
            (override): override is typeof override & { repository_id: number } =>
              typeof override.repository_id === 'number'
          )
          .map(override => ({
            repositoryId: override.repository_id,
            repoFullName: override.repo_full_name,
            modelSlug: override.model_slug,
            thinkingEffort: override.thinking_effort ?? null,
          })),
        disableReviewMd: cfg.disable_review_md ?? true,
        // Council is org-only; personal configs never set it, but expose it so the query shape
        // matches the org query (the form's `configData` is a union of the two).
        council: cfg.council ?? null,
        councilEnabledRepositoryIds: cfg.council_enabled_repository_ids ?? [],
        reviewMemoryEnabled: getReviewMemoryEnabledFromConfig(config.config),
        actionRequired: getCodeReviewActionRequiredState(config),
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

        // Per-repository model overrides are independent of the trigger selection —
        // they apply in both 'all' and 'selected' modes. IDs are numeric for personal
        // (GitHub/GitLab) integrations, enforced by the input schema.
        const repositoryModelOverrides: RepositoryModelOverride[] = (
          input.repositoryModelOverrides ?? []
        ).map(override => ({
          repository_id: override.repositoryId,
          repo_full_name: override.repoFullName,
          model_slug: override.modelSlug,
          thinking_effort: override.thinkingEffort ?? null,
        }));

        // Save the agent config
        await upsertAgentConfigForOwner({
          owner,
          agentType: 'code_review',
          platform,
          config: {
            review_style: input.reviewStyle,
            focus_areas: input.focusAreas,
            custom_instructions: input.customInstructions || null,
            model_slug: input.modelSlug,
            thinking_effort: input.thinkingEffort ?? null,
            gate_threshold: input.gateThreshold ?? 'off',
            repository_selection_mode: input.repositorySelectionMode || 'all',
            selected_repository_ids: input.selectedRepositoryIds || [],
            manually_added_repositories: input.manuallyAddedRepositories || [],
            repository_model_overrides: repositoryModelOverrides,
            disable_review_md: input.disableReviewMd ?? true,
            review_memory_enabled: false,
            review_analytics_enabled: false,
          },
          preserveCodeReviewFeatureSettings: true,
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
                const accessToken = await getValidGitLabToken(integration, {
                  userId: ctx.user.id,
                });

                const selectedRepositoryIds = (input.selectedRepositoryIds ?? []).filter(
                  (repositoryId): repositoryId is number => typeof repositoryId === 'number'
                );
                const previousSelectedRepositoryIds = previousRepoIds.filter(
                  (repositoryId): repositoryId is number => typeof repositoryId === 'number'
                );
                const { result, updatedWebhooks } = await syncWebhooksForRepositories(
                  accessToken,
                  webhookSecret,
                  selectedRepositoryIds,
                  previousSelectedRepositoryIds,
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
   * Field-merge PATCH for the personal user's review agent configuration.
   *
   * Unlike `saveReviewConfig` (full-document overwrite), this procedure READS
   * the current stored config and applies ONLY the fields present in the
   * patch — every unlisted field is preserved verbatim. Designed for the
   * mobile app, which edits one or two settings at a time and must not
   * clobber `manuallyAddedRepositories`, `repositoryModelOverrides`, or
   * feature flags the mobile UI doesn't surface.
   *
   * Platform forcing from the full save is re-applied post-merge (GitLab
   * forces `repository_selection_mode = 'selected'`). GitLab webhook sync
   * runs ONLY when `selectedRepositoryIds` is present in the patch, so an
   * unrelated edit (e.g. `modelSlug` only) never touches integration
   * metadata.
   *
   * `preserveCodeReviewFeatureSettings: true` keeps `review_memory_enabled`
   * and `review_analytics_enabled` on the row even when the patch supplies
   * neither, matching the full-save contract.
   *
   * Throws `NOT_FOUND` if no stored config exists — a PATCH cannot
   * bootstrap a row (use `saveReviewConfig` for that).
   */
  patchReviewConfig: baseProcedure
    .input(PatchReviewConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const owner = { type: 'user' as const, id: ctx.user.id, userId: ctx.user.id };
        const platform = input.platform;

        const previousConfig = await getAgentConfigForOwner(owner, 'code_review', platform);
        if (!previousConfig) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message:
              'No existing review agent configuration to patch. Save one with saveReviewConfig first.',
          });
        }
        const previousRepoIds =
          ((previousConfig.config as CodeReviewAgentConfig | undefined)?.selected_repository_ids as
            | Array<number | string>
            | undefined) || [];

        // Convert the stored snake_case config to a camelCase snapshot for
        // the merge helper. Mirrors the field mapping used in
        // `getReviewConfig` so a round-trip PATCH is a no-op on the read
        // shape.
        const prevCfg = previousConfig.config as CodeReviewAgentConfig;
        const stored: CodeReviewStoredConfig = {
          reviewStyle: prevCfg.review_style || 'balanced',
          focusAreas: prevCfg.focus_areas || [],
          customInstructions: prevCfg.custom_instructions ?? null,
          modelSlug: prevCfg.model_slug || PRIMARY_DEFAULT_MODEL,
          thinkingEffort: prevCfg.thinking_effort ?? null,
          gateThreshold: prevCfg.gate_threshold ?? 'off',
          repositorySelectionMode: prevCfg.repository_selection_mode || 'all',
          selectedRepositoryIds: prevCfg.selected_repository_ids ?? [],
          repositoryModelOverrides: (prevCfg.repository_model_overrides ?? []).map(o => ({
            repositoryId: o.repository_id,
            repoFullName: o.repo_full_name,
            modelSlug: o.model_slug,
            thinkingEffort: o.thinking_effort ?? null,
          })),
          disableReviewMd: prevCfg.disable_review_md ?? true,
          manuallyAddedRepositories: prevCfg.manually_added_repositories || [],
        };

        // Field-merge: every key absent from `input` is preserved from
        // `stored`. `null` is an explicit "clear" (e.g. customInstructions).
        // Council-related keys aren't accepted by the personal input schema
        // so they can never reach this handler.
        const { platform: _ignored, ...rest } = input;
        const patch: CodeReviewFieldMergePatch = rest;
        const merged = applyCodeReviewConfigPatch(stored, patch);

        // Re-apply platform forcing post-merge. GitLab only supports
        // 'selected' repo mode server-side, so an omitted or 'all'
        // repositorySelectionMode is clamped to 'selected' here. The full
        // save applies the same clamp; the PATCH must too or a save→patch
        // round-trip could land on an invalid mode.
        const isGitLab = platform === PLATFORM.GITLAB;
        const repositorySelectionMode: 'all' | 'selected' = isGitLab
          ? 'selected'
          : (merged.repositorySelectionMode ?? 'all');

        const repositoryModelOverrides: RepositoryModelOverride[] = (
          merged.repositoryModelOverrides ?? []
        ).map(override => ({
          repository_id: override.repositoryId,
          repo_full_name: override.repoFullName,
          model_slug: override.modelSlug,
          thinking_effort: override.thinkingEffort ?? null,
        }));

        await upsertAgentConfigForOwner({
          owner,
          agentType: 'code_review',
          platform,
          config: {
            review_style: merged.reviewStyle ?? 'balanced',
            focus_areas: merged.focusAreas ?? [],
            custom_instructions: merged.customInstructions ?? null,
            model_slug: merged.modelSlug ?? PRIMARY_DEFAULT_MODEL,
            thinking_effort: merged.thinkingEffort ?? null,
            gate_threshold: merged.gateThreshold ?? 'off',
            repository_selection_mode: repositorySelectionMode,
            selected_repository_ids: (merged.selectedRepositoryIds ?? []).filter(
              (repositoryId): repositoryId is number => typeof repositoryId === 'number'
            ),
            manually_added_repositories: merged.manuallyAddedRepositories ?? [],
            repository_model_overrides: repositoryModelOverrides,
            disable_review_md: merged.disableReviewMd ?? true,
            review_memory_enabled: false,
            review_analytics_enabled: false,
          },
          preserveCodeReviewFeatureSettings: true,
          createdBy: ctx.user.id,
        });

        // GitLab webhook sync runs ONLY when the patch actually carries
        // `selectedRepositoryIds`. A patch that doesn't touch selection
        // (e.g. mobile updating `focusAreas`) must not mutate integration
        // metadata. Auto-configure is honored when present, defaulting to
        // true to match the full-save default.
        let webhookSyncResult = null;
        if (
          isGitLab &&
          input.selectedRepositoryIds !== undefined &&
          (input.autoConfigureWebhooks ?? true) &&
          repositorySelectionMode === 'selected'
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
                const accessToken = await getValidGitLabToken(integration, {
                  userId: ctx.user.id,
                });

                const selectedRepositoryIds = (input.selectedRepositoryIds ?? []).filter(
                  (repositoryId): repositoryId is number => typeof repositoryId === 'number'
                );
                const previousSelectedRepositoryIds = previousRepoIds.filter(
                  (repositoryId): repositoryId is number => typeof repositoryId === 'number'
                );
                const { result, updatedWebhooks } = await syncWebhooksForRepositories(
                  accessToken,
                  webhookSecret,
                  selectedRepositoryIds,
                  previousSelectedRepositoryIds,
                  configuredWebhooks,
                  instanceUrl
                );

                await updateIntegrationMetadataForOwner(owner, PLATFORM.GITLAB, {
                  configured_webhooks: updatedWebhooks,
                });

                webhookSyncResult = {
                  created: result.created.length,
                  updated: result.updated.length,
                  deleted: result.deleted.length,
                  errors: result.errors,
                };

                logExceptInTest('[patchReviewConfig] Webhook sync completed', webhookSyncResult);
              } catch (webhookError) {
                logExceptInTest('[patchReviewConfig] Webhook sync failed', {
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
        if (error instanceof TRPCError) throw error;
        console.error('Error patching review config:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to patch review configuration',
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
        await clearCodeReviewActionRequiredState({ owner, platform });

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
