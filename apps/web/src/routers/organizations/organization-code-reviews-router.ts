import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  organizationMemberProcedure,
  organizationBillingMutationProcedure,
  organizationMemberMutationProcedure,
  OrganizationIdInputSchema,
  ensureOrganizationAccess,
} from './utils';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import {
  getIntegrationForOrganization,
  updateIntegrationMetadata,
} from '@/lib/integrations/db/platform-integrations';
import {
  getAgentConfig,
  upsertAgentConfig,
  setAgentEnabled,
} from '@/lib/agent-config/db/agent-configs';

import {
  CodeReviewAgentConfigSchema,
  type CodeReviewAgentConfig,
} from '@/lib/agent-config/core/types';
import { fetchGitHubRepositoriesForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import { fetchGitLabRepositoriesForOrganization } from '@/lib/cloud-agent/gitlab-integration-helpers';
import { PRIMARY_DEFAULT_MODEL } from '@/lib/ai-gateway/models';
import { createDefaultCodeReviewConfig } from '@/lib/code-reviews/core/default-config';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { isPlatformIntegrationHealthy } from '@/lib/integrations/core/health';
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
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { getBitbucketCodeReviewerReadiness } from '@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache';
import {
  BitbucketCodeReviewWebhookConfigurationError,
  ensureBitbucketCodeReviewWorkspaceWebhook,
} from '@/lib/integrations/platforms/bitbucket/code-review-webhooks';
import { cleanupBitbucketCodeReviewerForIntegration } from '@/lib/integrations/platforms/bitbucket/code-review-cleanup';
import {
  ManualBitbucketCodeReviewTriggerError,
  triggerManualBitbucketCodeReview,
} from '@/lib/integrations/platforms/bitbucket/manual-code-review-trigger';

const PlatformSchema = z.enum(['github', 'gitlab', 'bitbucket']).default('github');

const ManuallyAddedRepositoryInputSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

const SaveReviewConfigInputSchema = OrganizationIdInputSchema.extend({
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
  selectedRepositoryIds: z.array(z.union([z.number(), z.string()])).optional(),
  manuallyAddedRepositories: z.array(ManuallyAddedRepositoryInputSchema).optional(),
  disableReviewMd: z.boolean().optional(),
  gateThreshold: z.enum(['off', 'all', 'warning', 'critical']).optional(),
  // GitLab-specific: auto-configure webhooks
  autoConfigureWebhooks: z.boolean().optional().default(true),
});

const CreateManualReviewJobInputSchema = OrganizationIdInputSchema.extend(
  ManualCodeReviewJobInputSchema.shape
);

const TriggerBitbucketCodeReviewInputSchema = OrganizationIdInputSchema.extend({
  pullRequestUrl: z.string().trim().min(1).max(2048),
});

type ReviewPlatform = z.infer<typeof PlatformSchema>;
type BitbucketCodeReviewerReadiness = Awaited<ReturnType<typeof getBitbucketCodeReviewerReadiness>>;

function requireRepositoryIdsForPlatform(
  platform: ReviewPlatform,
  repositoryIds: Array<number | string> | undefined
): Array<number | string> {
  if (platform === PLATFORM.BITBUCKET) return repositoryIds ?? [];

  const numericRepositoryIds = z.array(z.number()).safeParse(repositoryIds ?? []);
  if (!numericRepositoryIds.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `${platform === PLATFORM.GITHUB ? 'GitHub' : 'GitLab'} repository IDs must be numbers`,
    });
  }
  return numericRepositoryIds.data;
}

function requireBitbucketWorkspace(readiness: BitbucketCodeReviewerReadiness) {
  if (!readiness.connected || !readiness.integrationId || !readiness.workspace) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Connect an active Bitbucket Workspace Access Token before configuring Code Reviewer',
    });
  }

  return {
    integrationId: readiness.integrationId,
    workspaceUuid: readiness.workspace.uuid,
    workspaceSlug: readiness.workspace.slug,
  };
}

function requireBitbucketRepositorySelection(
  input: {
    repositorySelectionMode?: 'all' | 'selected';
    selectedRepositoryIds?: Array<number | string>;
  },
  readiness: BitbucketCodeReviewerReadiness
): string[] {
  if (input.repositorySelectionMode !== 'selected') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Bitbucket Code Reviewer requires selected-repository mode',
    });
  }

  const selectedRepositoryIds = z.array(z.uuid()).safeParse(input.selectedRepositoryIds);
  if (!selectedRepositoryIds.success || selectedRepositoryIds.data.length === 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Select at least one cached Bitbucket repository',
    });
  }
  if (new Set(selectedRepositoryIds.data).size !== selectedRepositoryIds.data.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repository selections must be unique',
    });
  }
  if (readiness.repositoryCache.status !== 'available') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Refresh the Bitbucket repository cache before configuring Code Reviewer',
    });
  }

  const cachedRepositoryIds = new Set(
    readiness.repositoryCache.repositories.map(repository => repository.id)
  );
  if (selectedRepositoryIds.data.some(repositoryId => !cachedRepositoryIds.has(repositoryId))) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Every selected Bitbucket repository must exactly match the current repository cache',
    });
  }

  return selectedRepositoryIds.data;
}

function requireBitbucketCodeReviewerScopes(readiness: BitbucketCodeReviewerReadiness): void {
  if (readiness.missingRequiredScopes.length > 0) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `Replace the Bitbucket Workspace Access Token with one that includes: ${readiness.missingRequiredScopes.join(', ')}`,
    });
  }
}

function bitbucketWebhookConfigurationErrorMessage(
  error: BitbucketCodeReviewWebhookConfigurationError
): string {
  if (error.code === 'callback_origin_invalid') {
    return 'Bitbucket webhook setup requires a public HTTPS BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL with no port. Point it at an HTTPS tunnel for this Next.js app, then restart Next.js.';
  }
  return 'Bitbucket webhook signing keys are not configured. Set BITBUCKET_CODE_REVIEW_WEBHOOK_SIGNING_KEYS and restart Next.js.';
}

function bitbucketWebhookSetupFailureMessage(reason?: string): string {
  switch (reason) {
    case 'invalid_request':
      return 'Bitbucket webhook setup requires a public HTTPS BITBUCKET_CODE_REVIEW_WEBHOOK_BASE_URL with no port. Point it at an HTTPS tunnel for this Next.js app, then restart Next.js.';
    case 'insufficient_permissions':
      return 'Replace the Bitbucket Workspace Access Token with one that includes the webhook scope, then try again';
    case 'not_connected':
    case 'reconnect_required':
      return 'Reconnect the Bitbucket Workspace Access Token and try again';
    case 'temporarily_unavailable':
      return 'Bitbucket webhook setup is temporarily unavailable. Check GIT_TOKEN_SERVICE_API_URL and the git-token-service, then try again';
    default:
      return 'Bitbucket workspace webhook setup failed. Verify the token and try again';
  }
}

function manualBitbucketCodeReviewErrorCode(error: ManualBitbucketCodeReviewTriggerError) {
  switch (error.code) {
    case 'invalid_url':
    case 'repository_not_selected':
      return 'BAD_REQUEST' as const;
    case 'lifecycle_changed':
      return 'CONFLICT' as const;
    case 'processing_failed':
      return 'INTERNAL_SERVER_ERROR' as const;
    default:
      return 'PRECONDITION_FAILED' as const;
  }
}

async function ensureBitbucketWorkspaceWebhook(input: {
  organizationId: string;
  currentManagerId: string;
  workspace: ReturnType<typeof requireBitbucketWorkspace>;
}): Promise<void> {
  let result;
  try {
    result = await ensureBitbucketCodeReviewWorkspaceWebhook(input);
  } catch (error) {
    if (error instanceof BitbucketCodeReviewWebhookConfigurationError) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: bitbucketWebhookConfigurationErrorMessage(error),
      });
    }
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: bitbucketWebhookSetupFailureMessage(),
    });
  }
  if (!result.success) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: bitbucketWebhookSetupFailureMessage(result.reason),
    });
  }
}

export const organizationReviewAgentRouter = createTRPCRouter({
  createManualReviewJob: organizationMemberMutationProcedure
    .input(CreateManualReviewJobInputSchema)
    .mutation(async ({ input }) => {
      const botUser = await ensureBotUserForOrg(input.organizationId, 'code-review');
      const owner = { type: 'org' as const, id: input.organizationId, userId: botUser.id };
      return await createManualCodeReviewJob({
        owner,
        input: {
          platform: input.platform,
          url: input.url,
          modelSlug: input.modelSlug,
          thinkingEffort: input.thinkingEffort,
          instructions: input.instructions,
        },
      });
    }),

  getBitbucketReadiness: baseProcedure
    .input(OrganizationIdInputSchema)
    .query(async ({ input, ctx }) => {
      const role = await ensureOrganizationAccess(ctx, input.organizationId);
      const readiness = await getBitbucketCodeReviewerReadiness(input.organizationId);
      return {
        ...readiness,
        canManage: role === 'owner' || role === 'billing_manager',
        canTriggerManualReview: ctx.user.is_admin,
      };
    }),

  triggerBitbucketCodeReview: baseProcedure
    .input(TriggerBitbucketCodeReviewInputSchema)
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user.is_admin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin access required',
        });
      }
      await ensureOrganizationAccess(ctx, input.organizationId);

      try {
        const result = await triggerManualBitbucketCodeReview({
          organizationId: input.organizationId,
          pullRequestUrl: input.pullRequestUrl,
        });
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Manually requested Bitbucket Code Reviewer for ${input.pullRequestUrl}`,
        });
        return result;
      } catch (error) {
        if (error instanceof ManualBitbucketCodeReviewTriggerError) {
          throw new TRPCError({
            code: manualBitbucketCodeReviewErrorCode(error),
            message: error.message,
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to start Bitbucket Code Reviewer',
        });
      }
    }),

  /**
   * Gets the GitHub App installation status
   * (Replaces getGitHubStatus - now checks for GitHub App instead of OAuth)
   */
  getGitHubStatus: organizationMemberProcedure.query(async ({ input }) => {
    const integration = await getIntegrationForOrganization(input.organizationId, 'github');

    if (!isPlatformIntegrationHealthy(integration)) {
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
        isValid: true,
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

    if (!isPlatformIntegrationHealthy(integration)) {
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
        isValid: true,
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
          modelSlug: PRIMARY_DEFAULT_MODEL,
          thinkingEffort: null satisfies string | null,
          gateThreshold: 'off' as const,
          repositorySelectionMode:
            platform === 'bitbucket' ? ('selected' as const) : ('all' as const),
          selectedRepositoryIds: [],
          manuallyAddedRepositories: [],
          disableReviewMd: true,
          reviewMemoryEnabled: false,
          actionRequired: null,
        };
      }

      const cfg = config.config as CodeReviewAgentConfig;
      const isBitbucket = platform === PLATFORM.BITBUCKET;
      const selectedRepositoryIds = isBitbucket
        ? (cfg.selected_repository_ids ?? []).filter(
            (repositoryId): repositoryId is string => typeof repositoryId === 'string'
          )
        : (cfg.selected_repository_ids ?? []).filter(
            (repositoryId): repositoryId is number => typeof repositoryId === 'number'
          );
      return {
        isEnabled: config.is_enabled,
        reviewStyle: cfg.review_style || 'balanced',
        focusAreas: cfg.focus_areas || [],
        customInstructions: cfg.custom_instructions || null,
        modelSlug: cfg.model_slug || PRIMARY_DEFAULT_MODEL,
        thinkingEffort: cfg.thinking_effort ?? null,
        gateThreshold: isBitbucket ? ('off' as const) : (cfg.gate_threshold ?? 'off'),
        repositorySelectionMode: isBitbucket
          ? ('selected' as const)
          : cfg.repository_selection_mode || 'all',
        selectedRepositoryIds,
        manuallyAddedRepositories: isBitbucket ? [] : cfg.manually_added_repositories || [],
        disableReviewMd: isBitbucket ? true : (cfg.disable_review_md ?? true),
        reviewMemoryEnabled: isBitbucket ? false : getReviewMemoryEnabledFromConfig(config.config),
        actionRequired: getCodeReviewActionRequiredState(config),
      };
    }),

  /**
   * Saves the review agent configuration
   * For GitLab: optionally syncs webhooks for selected repositories
   */
  saveReviewConfig: organizationBillingMutationProcedure
    .input(SaveReviewConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const platform = input.platform ?? 'github';
        const isBitbucket = platform === PLATFORM.BITBUCKET;

        const previousConfig = await getAgentConfig(input.organizationId, 'code_review', platform);
        const previousRepoIds =
          (previousConfig?.config as CodeReviewAgentConfig | undefined)?.selected_repository_ids ||
          [];
        let selectedRepositoryIds = requireRepositoryIdsForPlatform(
          platform,
          input.selectedRepositoryIds
        );

        if (isBitbucket) {
          const readiness = await getBitbucketCodeReviewerReadiness(input.organizationId);
          const workspace = requireBitbucketWorkspace(readiness);
          selectedRepositoryIds = requireBitbucketRepositorySelection(input, readiness);
          if (previousConfig?.is_enabled) {
            await ensureBitbucketWorkspaceWebhook({
              organizationId: input.organizationId,
              currentManagerId: ctx.user.id,
              workspace,
            });
          }
        }

        await upsertAgentConfig({
          organizationId: input.organizationId,
          agentType: 'code_review',
          platform,
          config: {
            review_style: input.reviewStyle,
            focus_areas: input.focusAreas,
            custom_instructions: input.customInstructions || null,
            model_slug: input.modelSlug,
            thinking_effort: input.thinkingEffort ?? null,
            gate_threshold: isBitbucket ? 'off' : (input.gateThreshold ?? 'off'),
            repository_selection_mode: isBitbucket
              ? 'selected'
              : input.repositorySelectionMode || 'all',
            selected_repository_ids: selectedRepositoryIds,
            manually_added_repositories: isBitbucket ? [] : input.manuallyAddedRepositories || [],
            disable_review_md: isBitbucket ? true : (input.disableReviewMd ?? true),
            review_memory_enabled: false,
            review_analytics_enabled: false,
          },
          preserveCodeReviewFeatureSettings: !isBitbucket,
          isEnabled: isBitbucket && !previousConfig ? false : undefined,
          createdBy: ctx.user.id,
        });

        // For GitLab: sync webhooks if auto-configure is enabled
        let webhookSyncResult = null;
        if (
          platform === PLATFORM.GITLAB &&
          input.autoConfigureWebhooks !== false &&
          input.repositorySelectionMode === 'selected'
        ) {
          const integration = await getIntegrationForOrganization(
            input.organizationId,
            PLATFORM.GITLAB
          );
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
                const existingMetadata = (integration.metadata as Record<string, unknown>) || {};
                await updateIntegrationMetadata(integration.id, {
                  ...existingMetadata,
                  configured_webhooks: updatedWebhooks,
                });

                webhookSyncResult = {
                  created: result.created.length,
                  updated: result.updated.length,
                  deleted: result.deleted.length,
                  errors: result.errors,
                };

                logExceptInTest(
                  '[saveReviewConfig] Webhook sync completed for organization',
                  webhookSyncResult
                );
              } catch (webhookError) {
                // Log but don't fail the config save
                logExceptInTest('[saveReviewConfig] Webhook sync failed for organization', {
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

        // Audit log
        await createAuditLog({
          organization_id: input.organizationId,
          action: 'organization.settings.change',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          message: `Updated Review Agent configuration for ${platform} (style: ${input.reviewStyle})${webhookSyncResult ? `, webhooks: ${webhookSyncResult.created} created, ${webhookSyncResult.deleted} deleted` : ''}`,
        });

        return {
          success: true,
          webhookSync: webhookSyncResult,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
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
  toggleReviewAgent: organizationBillingMutationProcedure
    .input(
      OrganizationIdInputSchema.extend({
        platform: PlatformSchema,
        isEnabled: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const platform = input.platform ?? 'github';
        const owner = {
          type: 'org' as const,
          id: input.organizationId,
          userId: ctx.user.id,
        };

        const existingConfig = await getAgentConfig(input.organizationId, 'code_review', platform);
        let didChange = false;

        if (platform === PLATFORM.BITBUCKET && input.isEnabled) {
          const config = existingConfig;
          const parsedConfig = CodeReviewAgentConfigSchema.safeParse(config?.config);
          if (!config || !parsedConfig.success) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Save a valid Bitbucket Code Reviewer configuration before enabling it',
            });
          }

          const readiness = await getBitbucketCodeReviewerReadiness(input.organizationId);
          const workspace = requireBitbucketWorkspace(readiness);
          requireBitbucketRepositorySelection(
            {
              repositorySelectionMode: parsedConfig.data.repository_selection_mode,
              selectedRepositoryIds: parsedConfig.data.selected_repository_ids,
            },
            readiness
          );
          requireBitbucketCodeReviewerScopes(readiness);

          try {
            await ensureBotUserForOrg(input.organizationId, 'code-review');
          } catch {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Code Reviewer bot setup failed. Try enabling Code Reviewer again',
            });
          }
          await ensureBitbucketWorkspaceWebhook({
            organizationId: input.organizationId,
            currentManagerId: ctx.user.id,
            workspace,
          });

          const [freshConfig, freshReadiness] = await Promise.all([
            getAgentConfig(input.organizationId, 'code_review', platform),
            getBitbucketCodeReviewerReadiness(input.organizationId),
          ]);
          const freshWorkspace = requireBitbucketWorkspace(freshReadiness);
          if (
            freshWorkspace.integrationId !== workspace.integrationId ||
            freshWorkspace.workspaceUuid !== workspace.workspaceUuid ||
            freshWorkspace.workspaceSlug !== workspace.workspaceSlug
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'The Bitbucket integration changed during enablement. Try again',
            });
          }
          requireBitbucketCodeReviewerScopes(freshReadiness);

          const freshParsedConfig = CodeReviewAgentConfigSchema.safeParse(freshConfig?.config);
          if (!freshConfig || !freshParsedConfig.success) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Save a valid Bitbucket Code Reviewer configuration before enabling it',
            });
          }
          requireBitbucketRepositorySelection(
            {
              repositorySelectionMode: freshParsedConfig.data.repository_selection_mode,
              selectedRepositoryIds: freshParsedConfig.data.selected_repository_ids,
            },
            freshReadiness
          );

          await setAgentEnabled(input.organizationId, 'code_review', platform, true);
          didChange = config.is_enabled !== true;
        } else if (platform === PLATFORM.BITBUCKET) {
          const readiness = await getBitbucketCodeReviewerReadiness(input.organizationId);
          didChange = existingConfig?.is_enabled === true;
          if (readiness.integrationId) {
            await cleanupBitbucketCodeReviewerForIntegration({
              organizationId: input.organizationId,
              currentManagerId: ctx.user.id,
              integrationId: readiness.integrationId,
              workspace: readiness.workspace,
            });
          } else if (existingConfig) {
            await setAgentEnabled(input.organizationId, 'code_review', platform, false);
          } else {
            didChange = false;
          }
        } else if (existingConfig) {
          await setAgentEnabled(input.organizationId, 'code_review', platform, input.isEnabled);
          // Re-toggling to the same value is a no-op and must not be audited.
          didChange = existingConfig.is_enabled !== input.isEnabled;
        } else if (input.isEnabled) {
          await upsertAgentConfig({
            organizationId: input.organizationId,
            agentType: 'code_review',
            platform,
            isEnabled: true,
            createdBy: ctx.user.id,
            config: createDefaultCodeReviewConfig(),
          });
          didChange = true;
        } else {
          didChange = false;
        }
        await clearCodeReviewActionRequiredState({ owner, platform });

        // Only audit a real state transition. Disabling a platform that never
        // had a config row is a no-op and must not log a false "Disabled" event.
        if (didChange) {
          await createAuditLog({
            organization_id: input.organizationId,
            action: 'organization.settings.change',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            message: `${input.isEnabled ? 'Enabled' : 'Disabled'} AI Code Review Agent for ${platform}`,
          });
        }

        return { success: true, isEnabled: input.isEnabled };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error toggling review agent:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to toggle review agent',
        });
      }
    }),
});
