import type { TRPCContext } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import {
  type getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { fetchGitHubRepositories } from '@/lib/integrations/platforms/github/adapter';
import {
  getSecurityAgentConfigWithStatus,
  upsertSecurityAgentConfig,
  setSecurityAgentEnabled,
} from '@/lib/security-agent/db/security-config';
import {
  listSecurityFindings,
  getSecurityFindingById,
  getSecurityFindingsSummary,
  updateSecurityFindingStatus,
  getLastSyncTime as getLastSyncTimeDb,
  getOrphanedRepositoriesWithFindingCounts,
  deleteFindingsByRepository as deleteFindingsByRepositoryDb,
} from '@/lib/security-agent/db/security-findings';
import { getDashboardStats } from '@/lib/security-agent/db/dashboard-stats';
import {
  canStartAnalysis,
  enqueueBacklogFindings,
} from '@/lib/security-agent/db/security-analysis';
import {
  hasSecurityReviewPermissions,
  getReauthorizeUrl,
} from '@/lib/security-agent/github/permissions';
import {
  syncDependabotAlertsForRepo,
  syncAllReposForOwner,
} from '@/lib/security-agent/services/sync-service';
import { startSecurityAnalysis } from '@/lib/security-agent/services/analysis-service';
import { trpcCodeForAnalysisError } from '@/lib/security-agent/core/error-classification';
import {
  autoDismissEligibleFindings,
  countEligibleForAutoDismiss,
} from '@/lib/security-agent/services/auto-dismiss-service';
import { dismissDependabotAlert } from '@/lib/security-agent/github/dependabot-api';
import { rethrowAsPaymentRequired } from '@/lib/cloud-agent-next/cloud-agent-client';
import type { SecurityReviewOwner } from '@/lib/security-agent/core/types';
import type { SecurityFinding } from '@kilocode/db/schema';
import {
  SaveSecurityConfigInputSchema,
  ListFindingsInputSchema,
  TriggerSyncInputSchema,
  DismissFindingInputSchema,
  GetFindingInputSchema,
  SetEnabledInputSchema,
  StartAnalysisInputSchema,
  GetAnalysisInputSchema,
  DeleteFindingsByRepoInputSchema,
  GetDashboardStatsInputSchema,
  type SaveSecurityConfigInput,
  type ListFindingsInput,
  type TriggerSyncInput,
  type DismissFindingInput,
  type GetFindingInput,
  type SetEnabledInput,
  type StartAnalysisInput,
  type GetAnalysisInput,
  type DeleteFindingsByRepoInput,
  type GetDashboardStatsInput,
} from '@/lib/security-agent/core/schemas';
import {
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
} from '@/lib/security-agent/core/constants';
import {
  trackSecurityAgentEnabled,
  trackSecurityAgentConfigSaved,
  trackSecurityAgentSync,
  trackSecurityAgentFindingDismissed,
} from '@/lib/security-agent/posthog-tracking';
import {
  logSecurityAudit,
  SecurityAuditLogAction,
} from '@/lib/security-agent/services/audit-log-service';

// ---------------------------------------------------------------------------
// Strategy types
// ---------------------------------------------------------------------------

type Owner = { type: 'user' | 'org'; id: string; userId: string };

type Integration = Awaited<ReturnType<typeof getIntegrationForOwner>>;

/**
 * TExtra represents additional input fields injected by the tRPC procedure middleware.
 * For personal routers this is `{}`, for org routers it is `{ organizationId: string }`.
 * This avoids `as` casts throughout the handlers and org router callbacks.
 */
type SecurityAgentDeps<TExtra = {}> = {
  resolveOwner: (ctx: TRPCContext, input: TExtra) => Owner;
  resolveSecurityOwner: (ctx: TRPCContext, input: TExtra) => SecurityReviewOwner;
  resolveResourceId: (ctx: TRPCContext, input: TExtra) => string;
  verifyFindingOwnership: (finding: SecurityFinding, ctx: TRPCContext, input: TExtra) => boolean;
  getIntegration: (ctx: TRPCContext, input: TExtra) => Promise<Integration>;
  getGitHubToken: (ctx: TRPCContext, input: TExtra) => Promise<string | null>;
  trackingExtras: (ctx: TRPCContext, input: TExtra) => Record<string, string>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSecurityAgentHandlers<TExtra = {}>(deps: SecurityAgentDeps<TExtra>) {
  // tRPC passes `undefined` for no-input procedures.  For the personal router
  // TExtra = {}, so the fallback `{}` is structurally correct.  For the org
  // router the middleware always injects `{ organizationId }`.  The cast is
  // the single unavoidable type-unsafe bridge between tRPC's `unknown` input
  // and our generic callbacks.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toExtra = (input: unknown): TExtra => (input ?? {}) as any;

  return {
    // -----------------------------------------------------------------------
    // 1. getPermissionStatus
    // -----------------------------------------------------------------------
    getPermissionStatus: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const integration = await deps.getIntegration(ctx, extra);

      if (!integration || integration.integration_status !== 'active') {
        return {
          hasIntegration: false,
          hasPermissions: false,
          reauthorizeUrl: null,
        };
      }

      const hasPermissions = hasSecurityReviewPermissions(integration);

      return {
        hasIntegration: true,
        hasPermissions,
        reauthorizeUrl: hasPermissions
          ? null
          : integration.platform_installation_id
            ? getReauthorizeUrl(integration.platform_installation_id)
            : null,
      };
    },

    // -----------------------------------------------------------------------
    // 2. getConfig
    // -----------------------------------------------------------------------
    getConfig: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const owner = deps.resolveOwner(ctx, extra);
      const result = await getSecurityAgentConfigWithStatus(owner);

      if (!result) {
        return {
          isEnabled: false,
          slaCriticalDays: 15,
          slaHighDays: 30,
          slaMediumDays: 45,
          slaLowDays: 90,
          autoSyncEnabled: true,
          repositorySelectionMode: 'selected' as const,
          selectedRepositoryIds: [] as number[],
          modelSlug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
          triageModelSlug: DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
          analysisModelSlug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
          analysisMode: 'auto' as const,
          autoDismissEnabled: false,
          autoDismissConfidenceThreshold: 'high' as const,
          autoAnalysisEnabled: false,
          autoAnalysisMinSeverity: 'high' as const,
          autoAnalysisIncludeExisting: false,
        };
      }

      const triageModelSlug =
        result.storedConfig.triage_model_slug ??
        result.storedConfig.model_slug ??
        result.config.triage_model_slug ??
        DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
      const analysisModelSlug =
        result.storedConfig.analysis_model_slug ??
        result.storedConfig.model_slug ??
        result.config.analysis_model_slug ??
        DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;

      return {
        isEnabled: result.isEnabled,
        slaCriticalDays: result.config.sla_critical_days,
        slaHighDays: result.config.sla_high_days,
        slaMediumDays: result.config.sla_medium_days,
        slaLowDays: result.config.sla_low_days,
        autoSyncEnabled: result.config.auto_sync_enabled,
        repositorySelectionMode: result.config.repository_selection_mode || 'selected',
        selectedRepositoryIds: result.config.selected_repository_ids || [],
        modelSlug: result.config.model_slug || analysisModelSlug,
        triageModelSlug,
        analysisModelSlug,
        analysisMode: result.config.analysis_mode ?? 'auto',
        autoDismissEnabled: result.config.auto_dismiss_enabled ?? false,
        autoDismissConfidenceThreshold: result.config.auto_dismiss_confidence_threshold ?? 'high',
        autoAnalysisEnabled: result.config.auto_analysis_enabled ?? false,
        autoAnalysisMinSeverity: result.config.auto_analysis_min_severity ?? 'high',
        autoAnalysisIncludeExisting: result.config.auto_analysis_include_existing ?? false,
      };
    },

    // -----------------------------------------------------------------------
    // 3. saveConfig
    // -----------------------------------------------------------------------
    saveConfig: {
      inputSchema: SaveSecurityConfigInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: SaveSecurityConfigInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const resourceId = deps.resolveResourceId(ctx, input);

        const existingConfig = await getSecurityAgentConfigWithStatus(owner);
        const existingTriageModelSlug =
          existingConfig?.storedConfig.triage_model_slug ??
          existingConfig?.storedConfig.model_slug ??
          existingConfig?.config.triage_model_slug ??
          DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
        const existingAnalysisModelSlug =
          existingConfig?.storedConfig.analysis_model_slug ??
          existingConfig?.storedConfig.model_slug ??
          existingConfig?.config.analysis_model_slug ??
          DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;
        const beforeState = existingConfig
          ? {
              autoSyncEnabled: existingConfig.config.auto_sync_enabled,
              analysisMode: existingConfig.config.analysis_mode,
              autoDismissEnabled: existingConfig.config.auto_dismiss_enabled,
              autoDismissConfidenceThreshold:
                existingConfig.config.auto_dismiss_confidence_threshold,
              autoAnalysisEnabled: existingConfig.config.auto_analysis_enabled,
              autoAnalysisMinSeverity: existingConfig.config.auto_analysis_min_severity,
              autoAnalysisIncludeExisting: existingConfig.config.auto_analysis_include_existing,
              modelSlug: existingConfig.config.model_slug,
              triageModelSlug: existingTriageModelSlug,
              analysisModelSlug: existingAnalysisModelSlug,
              repositorySelectionMode: existingConfig.config.repository_selection_mode,
              selectedRepositoryIds: existingConfig.config.selected_repository_ids,
              slaCriticalDays: existingConfig.config.sla_critical_days,
              slaHighDays: existingConfig.config.sla_high_days,
              slaMediumDays: existingConfig.config.sla_medium_days,
              slaLowDays: existingConfig.config.sla_low_days,
            }
          : undefined;

        const triageModelSlug =
          input.triageModelSlug ??
          (input.modelSlug ? input.modelSlug : undefined) ??
          existingTriageModelSlug;
        const analysisModelSlug =
          input.analysisModelSlug ??
          (input.modelSlug ? input.modelSlug : undefined) ??
          existingAnalysisModelSlug;
        const modelSlug =
          input.modelSlug ??
          existingConfig?.storedConfig.model_slug ??
          analysisModelSlug ??
          triageModelSlug;

        await upsertSecurityAgentConfig(
          owner,
          {
            sla_critical_days: input.slaCriticalDays,
            sla_high_days: input.slaHighDays,
            sla_medium_days: input.slaMediumDays,
            sla_low_days: input.slaLowDays,
            auto_sync_enabled: input.autoSyncEnabled,
            repository_selection_mode: input.repositorySelectionMode,
            selected_repository_ids: input.selectedRepositoryIds,
            model_slug: modelSlug,
            triage_model_slug: triageModelSlug,
            analysis_model_slug: analysisModelSlug,
            analysis_mode: input.analysisMode,
            auto_dismiss_enabled: input.autoDismissEnabled,
            auto_dismiss_confidence_threshold: input.autoDismissConfidenceThreshold,
            auto_analysis_enabled: input.autoAnalysisEnabled,
            auto_analysis_min_severity: input.autoAnalysisMinSeverity,
            auto_analysis_include_existing: input.autoAnalysisIncludeExisting,
          },
          ctx.user.id
        );

        // Enqueue backlog findings when include_existing becomes active — either
        // because it was just toggled ON, or because auto-analysis was re-enabled
        // while include_existing was already ON.
        const wasAutoAnalysisOn = existingConfig?.config.auto_analysis_enabled ?? false;
        const isAutoAnalysisOn =
          input.autoAnalysisEnabled ?? existingConfig?.config.auto_analysis_enabled ?? false;
        const wasIncludeExisting = existingConfig?.config.auto_analysis_include_existing ?? false;
        const isNowIncludeExisting = input.autoAnalysisIncludeExisting ?? wasIncludeExisting;

        const includeExistingJustTurnedOn = isNowIncludeExisting && !wasIncludeExisting;
        const autoAnalysisReEnabled =
          isAutoAnalysisOn && !wasAutoAnalysisOn && isNowIncludeExisting;

        if (isAutoAnalysisOn && (includeExistingJustTurnedOn || autoAnalysisReEnabled)) {
          enqueueBacklogFindings({
            owner: securityOwner,
            autoAnalysisMinSeverity:
              input.autoAnalysisMinSeverity ??
              existingConfig?.config.auto_analysis_min_severity ??
              'high',
          }).catch(error => {
            // Fire-and-forget: don't fail the config save if backlog enqueue errors.
            // The next sync cron will pick up any missed findings.
            console.error('Failed to enqueue backlog findings', error);
          });
        }

        trackSecurityAgentConfigSaved({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          autoSyncEnabled: input.autoSyncEnabled,
          analysisMode: input.analysisMode,
          autoDismissEnabled: input.autoDismissEnabled,
          autoDismissConfidenceThreshold: input.autoDismissConfidenceThreshold,
          modelSlug,
          triageModelSlug,
          analysisModelSlug,
          repositorySelectionMode: input.repositorySelectionMode,
          selectedRepoCount: input.selectedRepositoryIds?.length,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: SecurityAuditLogAction.ConfigUpdated,
          resource_type: 'agent_config',
          resource_id: resourceId,
          before_state: beforeState,
          after_state: {
            autoSyncEnabled: input.autoSyncEnabled,
            analysisMode: input.analysisMode,
            autoDismissEnabled: input.autoDismissEnabled,
            autoDismissConfidenceThreshold: input.autoDismissConfidenceThreshold,
            autoAnalysisEnabled: input.autoAnalysisEnabled,
            autoAnalysisMinSeverity: input.autoAnalysisMinSeverity,
            autoAnalysisIncludeExisting: input.autoAnalysisIncludeExisting,
            modelSlug,
            triageModelSlug,
            analysisModelSlug,
            repositorySelectionMode: input.repositorySelectionMode,
            selectedRepositoryIds: input.selectedRepositoryIds,
            slaCriticalDays: input.slaCriticalDays,
            slaHighDays: input.slaHighDays,
            slaMediumDays: input.slaMediumDays,
            slaLowDays: input.slaLowDays,
          },
        });

        return { success: true };
      },
    },

    // -----------------------------------------------------------------------
    // 4. setEnabled
    // -----------------------------------------------------------------------
    setEnabled: {
      inputSchema: SetEnabledInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: SetEnabledInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const resourceId = deps.resolveResourceId(ctx, input);

        // Get integration (needed for both permission check and sync)
        const integration = await deps.getIntegration(ctx, input);

        // Check permissions before enabling
        if (input.isEnabled) {
          if (!integration || !hasSecurityReviewPermissions(integration)) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'GitHub App does not have vulnerability_alerts permission',
            });
          }
        }

        // Determine repository selection
        const existingConfig = await getSecurityAgentConfigWithStatus(owner);
        const selectionMode =
          input.repositorySelectionMode ??
          existingConfig?.config.repository_selection_mode ??
          'selected';
        const selectedIds =
          input.selectedRepositoryIds ?? existingConfig?.config.selected_repository_ids ?? [];

        // Always upsert the config when enabling to ensure it exists with the correct selection
        if (input.isEnabled) {
          await upsertSecurityAgentConfig(
            owner,
            {
              repository_selection_mode: selectionMode,
              selected_repository_ids: selectedIds,
            },
            ctx.user.id
          );
        }

        await setSecurityAgentEnabled(owner, input.isEnabled);

        // When enabling, trigger an initial sync of repositories
        if (input.isEnabled && integration) {
          const installationId = integration.platform_installation_id;
          if (installationId) {
            const allRepos = integration.repositories || [];

            let repositoriesToSync: string[];

            if (selectionMode === 'all') {
              repositoriesToSync = allRepos
                .map(r => r.full_name)
                .filter((name): name is string => !!name);
            } else {
              repositoriesToSync = allRepos
                .filter(r => selectedIds.includes(r.id))
                .map(r => r.full_name)
                .filter((name): name is string => !!name);
            }

            if (repositoriesToSync.length > 0) {
              const syncResult = await syncAllReposForOwner({
                owner: securityOwner,
                platformIntegrationId: integration.id,
                installationId,
                repositories: repositoriesToSync,
              });

              trackSecurityAgentEnabled({
                distinctId: ctx.user.id,
                userId: ctx.user.id,
                ...deps.trackingExtras(ctx, input),
                isEnabled: input.isEnabled,
                repositorySelectionMode: selectionMode,
                selectedRepoCount: repositoriesToSync.length,
                syncedCount: syncResult.synced,
                syncErrors: syncResult.errors,
              });

              logSecurityAudit({
                owner: securityOwner,
                actor_id: ctx.user.id,
                actor_email: ctx.user.google_user_email,
                actor_name: ctx.user.google_user_name,
                action: SecurityAuditLogAction.ConfigEnabled,
                resource_type: 'agent_config',
                resource_id: resourceId,
                after_state: { isEnabled: true, repositorySelectionMode: selectionMode },
              });

              return {
                success: true,
                syncResult: {
                  synced: syncResult.synced,
                  errors: syncResult.errors,
                },
              };
            }
          }
        }

        const effectiveRepoCount =
          selectionMode === 'all'
            ? (integration?.repositories || []).filter(r => !!r.full_name).length
            : selectedIds.length;

        trackSecurityAgentEnabled({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          isEnabled: input.isEnabled,
          repositorySelectionMode: selectionMode,
          selectedRepoCount: effectiveRepoCount,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: input.isEnabled
            ? SecurityAuditLogAction.ConfigEnabled
            : SecurityAuditLogAction.ConfigDisabled,
          resource_type: 'agent_config',
          resource_id: resourceId,
          after_state: { isEnabled: input.isEnabled, repositorySelectionMode: selectionMode },
        });

        return { success: true };
      },
    },

    // -----------------------------------------------------------------------
    // 5. getRepositories
    // -----------------------------------------------------------------------
    getRepositories: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const integration = await deps.getIntegration(ctx, extra);

      if (!integration || integration.integration_status !== 'active') {
        return [];
      }

      // Auto-fetch repositories from GitHub if not cached
      let repos = integration.repositories || [];
      if (repos.length === 0 && integration.platform_installation_id) {
        const appType = integration.github_app_type || 'standard';
        const fetchedRepos = await fetchGitHubRepositories(
          integration.platform_installation_id,
          appType
        );
        await updateRepositoriesForIntegration(integration.id, fetchedRepos);
        repos = fetchedRepos;
      }

      return repos.map(repo => ({
        id: repo.id,
        fullName: repo.full_name,
        name: repo.name,
        private: repo.private,
      }));
    },

    // -----------------------------------------------------------------------
    // 6. listFindings
    // -----------------------------------------------------------------------
    listFindings: {
      inputSchema: ListFindingsInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: ListFindingsInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        const { findings, totalCount } = await listSecurityFindings({
          owner: securityOwner,
          repoFullName: input.repoFullName,
          status: input.status,
          severity: input.severity,
          outcomeFilter: input.outcomeFilter,
          overdue: input.overdue,
          sortBy: input.sortBy,
          limit: input.limit,
          offset: input.offset,
        });

        const concurrencyCheck = await canStartAnalysis(securityOwner);

        return {
          findings,
          totalCount,
          runningCount: concurrencyCheck.currentCount,
          concurrencyLimit: concurrencyCheck.limit,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 7. getFinding
    // -----------------------------------------------------------------------
    getFinding: {
      inputSchema: GetFindingInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetFindingInput & TExtra;
      }) => {
        const input = rawInput;
        const finding = await getSecurityFindingById(input.id);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        return finding;
      },
    },

    // -----------------------------------------------------------------------
    // 8. getStats
    // -----------------------------------------------------------------------
    getStats: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);
      return await getSecurityFindingsSummary({ owner: securityOwner });
    },

    // -----------------------------------------------------------------------
    // 9. getLastSyncTime
    // -----------------------------------------------------------------------
    getLastSyncTime: {
      inputSchema: ListFindingsInputSchema.pick({ repoFullName: true }),
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: Pick<ListFindingsInput, 'repoFullName'> & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const lastSyncTime = await getLastSyncTimeDb({
          owner: securityOwner,
          repoFullName: input.repoFullName,
        });
        return { lastSyncTime };
      },
    },

    // -----------------------------------------------------------------------
    // 10. triggerSync
    // -----------------------------------------------------------------------
    triggerSync: {
      inputSchema: TriggerSyncInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: TriggerSyncInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const resourceId = deps.resolveResourceId(ctx, input);

        // Get integration
        const integration = await deps.getIntegration(ctx, input);
        if (!integration || integration.integration_status !== 'active') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub integration not found or inactive',
          });
        }

        // Check permissions
        if (!hasSecurityReviewPermissions(integration)) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub App does not have vulnerability_alerts permission',
          });
        }

        const installationId = integration.platform_installation_id;
        if (!installationId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub installation ID not found',
          });
        }

        const allRepos = integration.repositories || [];

        // If a specific repo is provided, sync only that one
        if (input.repoFullName) {
          const hasRepo = allRepos.some(r => r.full_name === input.repoFullName);
          if (!hasRepo) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Repository not found in your GitHub integration',
            });
          }

          const result = await syncDependabotAlertsForRepo({
            owner: securityOwner,
            platformIntegrationId: integration.id,
            installationId,
            repoFullName: input.repoFullName,
          });

          trackSecurityAgentSync({
            distinctId: ctx.user.id,
            userId: ctx.user.id,
            ...deps.trackingExtras(ctx, input),
            syncType: 'single_repo',
            repoCount: 1,
            synced: result.synced,
            errors: result.errors,
          });

          logSecurityAudit({
            owner: securityOwner,
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            action: SecurityAuditLogAction.SyncTriggered,
            resource_type: 'agent_config',
            resource_id: resourceId,
            metadata: {
              syncType: 'single_repo',
              repoFullName: input.repoFullName,
              synced: result.synced,
              errors: result.errors,
            },
          });

          return {
            success: true,
            synced: result.synced,
            errors: result.errors,
          };
        }

        // No specific repo - sync all enabled repositories based on config
        const config = await getSecurityAgentConfigWithStatus(owner);
        const selectionMode = config?.config.repository_selection_mode ?? 'selected';
        const selectedIds = config?.config.selected_repository_ids ?? [];

        let repositoriesToSync: string[];
        if (selectionMode === 'all') {
          repositoriesToSync = allRepos
            .map(r => r.full_name)
            .filter((name): name is string => !!name);
        } else {
          repositoriesToSync = allRepos
            .filter(r => selectedIds.includes(r.id))
            .map(r => r.full_name)
            .filter((name): name is string => !!name);
        }

        if (repositoriesToSync.length === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'No repositories configured for security reviews',
          });
        }

        const result = await syncAllReposForOwner({
          owner: securityOwner,
          platformIntegrationId: integration.id,
          installationId,
          repositories: repositoriesToSync,
        });

        trackSecurityAgentSync({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          syncType: 'all_repos',
          repoCount: repositoriesToSync.length,
          synced: result.synced,
          errors: result.errors,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: SecurityAuditLogAction.SyncTriggered,
          resource_type: 'agent_config',
          resource_id: resourceId,
          metadata: {
            syncType: 'all_repos',
            repoCount: repositoriesToSync.length,
            synced: result.synced,
            errors: result.errors,
          },
        });

        return {
          success: true,
          synced: result.synced,
          errors: result.errors,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 11. dismissFinding
    // -----------------------------------------------------------------------
    dismissFinding: {
      inputSchema: DismissFindingInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: DismissFindingInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        // Get the finding
        const finding = await getSecurityFindingById(input.findingId);
        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        // Verify ownership
        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        // Get integration for GitHub API call
        const integration = await deps.getIntegration(ctx, input);
        if (!integration || integration.integration_status !== 'active') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub integration not found or inactive',
          });
        }

        const installationId = integration.platform_installation_id;
        if (!installationId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub installation ID not found',
          });
        }

        // Parse repo owner and name from full name
        const [repoOwner, repoName] = finding.repo_full_name.split('/');
        if (!repoOwner || !repoName) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Invalid repository name format',
          });
        }

        // Dismiss on GitHub if it's a Dependabot alert
        if (finding.source === 'dependabot') {
          const alertNumber = parseInt(finding.source_id, 10);
          if (!isNaN(alertNumber)) {
            await dismissDependabotAlert(
              installationId,
              repoOwner,
              repoName,
              alertNumber,
              input.reason,
              input.comment
            );
          } else {
            console.warn(
              `Dependabot finding ${input.findingId} has non-numeric source_id "${finding.source_id}", skipping GitHub dismissal`
            );
          }
        }

        // Update local database
        await updateSecurityFindingStatus(input.findingId, 'ignored', {
          ignoredReason: input.reason,
          ignoredBy: ctx.user.google_user_email,
        });

        trackSecurityAgentFindingDismissed({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          findingId: input.findingId,
          reason: input.reason,
          source: finding.source,
          severity: finding.severity,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: SecurityAuditLogAction.FindingDismissed,
          resource_type: 'security_finding',
          resource_id: input.findingId,
          before_state: { status: finding.status },
          after_state: { status: 'ignored', ignoredReason: input.reason },
          metadata: { source: finding.source, severity: finding.severity },
        });

        return { success: true };
      },
    },

    // -----------------------------------------------------------------------
    // 12. startAnalysis
    // -----------------------------------------------------------------------
    startAnalysis: {
      inputSchema: StartAnalysisInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: StartAnalysisInput & TExtra;
      }) => {
        const input = rawInput;
        const owner = deps.resolveOwner(ctx, input);
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        const finding = await getSecurityFindingById(input.findingId);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        // Verify ownership
        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        // Check concurrency limit
        const concurrencyCheck = await canStartAnalysis(securityOwner);

        if (!concurrencyCheck.allowed) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: `Maximum concurrent analyses reached (${concurrencyCheck.currentCount}/${concurrencyCheck.limit}). Please wait for existing analyses to complete.`,
          });
        }

        // Get GitHub token
        const githubToken = await deps.getGitHubToken(ctx, input);

        if (!githubToken) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub integration required for analysis',
          });
        }

        // Resolve triage/analysis models with legacy fallbacks
        const config = await getSecurityAgentConfigWithStatus(owner);
        const triageModel =
          input.triageModel ||
          input.model ||
          config?.storedConfig.triage_model_slug ||
          config?.storedConfig.model_slug ||
          config?.config.triage_model_slug ||
          DEFAULT_SECURITY_AGENT_TRIAGE_MODEL;
        const analysisModel =
          input.analysisModel ||
          input.model ||
          config?.storedConfig.analysis_model_slug ||
          config?.storedConfig.model_slug ||
          config?.config.analysis_model_slug ||
          DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL;
        const analysisMode = config?.config.analysis_mode ?? 'auto';

        try {
          const result = await startSecurityAnalysis({
            findingId: input.findingId,
            user: ctx.user,
            githubRepo: finding.repo_full_name,
            githubToken,
            triageModel,
            analysisModel,
            analysisMode,
            retrySandboxOnly: input.retrySandboxOnly,
            organizationId: owner.type === 'org' ? owner.id : undefined,
          });

          if (!result.started) {
            throw new TRPCError({
              code: trpcCodeForAnalysisError(result.errorCode),
              message: result.error || 'Failed to start analysis',
            });
          }

          logSecurityAudit({
            owner: securityOwner,
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            action: SecurityAuditLogAction.FindingAnalysisStarted,
            resource_type: 'security_finding',
            resource_id: input.findingId,
            metadata: {
              model: analysisModel,
              triageModel,
              analysisModel,
              analysisMode,
              triageOnly: result.triageOnly,
            },
          });

          return { success: true, triageOnly: result.triageOnly };
        } catch (error) {
          rethrowAsPaymentRequired(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    // 13. getAnalysis
    // -----------------------------------------------------------------------
    getAnalysis: {
      inputSchema: GetAnalysisInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetAnalysisInput & TExtra;
      }) => {
        const input = rawInput;
        const finding = await getSecurityFindingById(input.findingId);

        if (!finding) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Security finding not found',
          });
        }

        // Verify ownership
        if (!deps.verifyFindingOwnership(finding, ctx, input)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have access to this finding',
          });
        }

        return {
          status: finding.analysis_status,
          startedAt: finding.analysis_started_at,
          completedAt: finding.analysis_completed_at,
          error: finding.analysis_error,
          analysis: finding.analysis,
          sessionId: finding.session_id,
          cliSessionId: finding.cli_session_id,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 14. getOrphanedRepositories
    // -----------------------------------------------------------------------
    getOrphanedRepositories: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);

      // Get the current GitHub integration
      const integration = await deps.getIntegration(ctx, extra);

      // Get list of accessible repository full names
      const accessibleRepoFullNames: string[] = [];
      if (integration && integration.integration_status === 'active') {
        const repos = integration.repositories || [];
        for (const repo of repos) {
          if (repo.full_name) {
            accessibleRepoFullNames.push(repo.full_name);
          }
        }
      }

      // Get orphaned repositories with finding counts
      const orphanedRepos = await getOrphanedRepositoriesWithFindingCounts({
        owner: securityOwner,
        accessibleRepoFullNames,
      });

      return orphanedRepos;
    },

    // -----------------------------------------------------------------------
    // 15. deleteFindingsByRepository
    // -----------------------------------------------------------------------
    deleteFindingsByRepository: {
      inputSchema: DeleteFindingsByRepoInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: DeleteFindingsByRepoInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);

        const result = await deleteFindingsByRepositoryDb({
          owner: securityOwner,
          repoFullName: input.repoFullName,
        });

        logSecurityAudit({
          owner: securityOwner,
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          action: SecurityAuditLogAction.FindingDeleted,
          resource_type: 'security_finding',
          resource_id: input.repoFullName,
          metadata: { repoFullName: input.repoFullName, deletedCount: result.deletedCount },
        });

        return {
          success: true,
          deletedCount: result.deletedCount,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 16. getAutoDismissEligible
    // -----------------------------------------------------------------------
    getAutoDismissEligible: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);
      const result = await countEligibleForAutoDismiss(securityOwner, ctx.user.id);

      return {
        eligible: result.eligible,
        byConfidence: result.byConfidence,
      };
    },

    // -----------------------------------------------------------------------
    // 17. autoDismissEligible
    // -----------------------------------------------------------------------
    autoDismissEligible: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);
      const result = await autoDismissEligibleFindings(securityOwner, ctx.user.id);

      logSecurityAudit({
        owner: securityOwner,
        actor_id: ctx.user.id,
        actor_email: ctx.user.google_user_email,
        actor_name: ctx.user.google_user_name,
        action: SecurityAuditLogAction.FindingAutoDismissed,
        resource_type: 'security_finding',
        resource_id: 'bulk',
        metadata: {
          source: 'bulk',
          dismissed: result.dismissed,
          skipped: result.skipped,
          errors: result.errors,
        },
      });

      return {
        dismissed: result.dismissed,
        skipped: result.skipped,
        errors: result.errors,
      };
    },

    // -----------------------------------------------------------------------
    // 18. getDashboardStats
    // -----------------------------------------------------------------------
    getDashboardStats: {
      inputSchema: GetDashboardStatsInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetDashboardStatsInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const owner = deps.resolveOwner(ctx, input);

        // Get config for SLA targets
        const config = await getSecurityAgentConfigWithStatus(owner);
        const slaConfig = {
          slaCriticalDays: config?.config.sla_critical_days ?? 15,
          slaHighDays: config?.config.sla_high_days ?? 30,
          slaMediumDays: config?.config.sla_medium_days ?? 45,
          slaLowDays: config?.config.sla_low_days ?? 90,
        };

        return getDashboardStats({
          owner: securityOwner,
          repoFullName: input.repoFullName,
          slaConfig,
        });
      },
    },
  };
}
