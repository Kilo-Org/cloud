import { createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import {
  organizationMemberProcedure,
  organizationOwnerProcedure,
  OrganizationIdInputSchema,
} from './utils';
import {
  getIntegrationForOrganization,
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
  getLastSyncTime,
  getOrphanedRepositoriesWithFindingCounts,
  deleteFindingsByRepository,
} from '@/lib/security-agent/db/security-findings';
import {
  canStartAnalysis,
  listSecurityFindingsWithAnalysis,
  countSecurityFindingsWithAnalysis,
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
import {
  autoDismissEligibleFindings,
  countEligibleForAutoDismiss,
} from '@/lib/security-agent/services/auto-dismiss-service';
import { dismissDependabotAlert } from '@/lib/security-agent/github/dependabot-api';
import { getGitHubTokenForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import type { SecurityReviewOwner } from '@/lib/security-agent/core/types';
import {
  SaveSecurityConfigInputSchema,
  ListFindingsInputSchema,
  TriggerSyncInputSchema,
  DismissFindingInputSchema,
  GetFindingInputSchema,
  SetEnabledInputSchema,
  StartAnalysisInputSchema,
  GetAnalysisInputSchema,
  ListAnalysisJobsInputSchema,
  DeleteFindingsByRepoInputSchema,
} from '@/lib/security-agent/core/schemas';
import { DEFAULT_SECURITY_AGENT_MODEL } from '@/lib/security-agent/core/constants';
import {
  trackSecurityAgentEnabled,
  trackSecurityAgentConfigSaved,
  trackSecurityAgentSync,
  trackSecurityAgentFindingDismissed,
} from '@/lib/security-agent/posthog-tracking';

const OrgSaveSecurityConfigInputSchema = OrganizationIdInputSchema.merge(
  SaveSecurityConfigInputSchema
);
const OrgListFindingsInputSchema = OrganizationIdInputSchema.merge(ListFindingsInputSchema);
const OrgTriggerSyncInputSchema = OrganizationIdInputSchema.merge(TriggerSyncInputSchema);
const OrgDismissFindingInputSchema = OrganizationIdInputSchema.merge(DismissFindingInputSchema);
const OrgGetFindingInputSchema = OrganizationIdInputSchema.merge(GetFindingInputSchema);
const OrgSetEnabledInputSchema = OrganizationIdInputSchema.merge(SetEnabledInputSchema);
const OrgStartAnalysisInputSchema = OrganizationIdInputSchema.merge(StartAnalysisInputSchema);
const OrgGetAnalysisInputSchema = OrganizationIdInputSchema.merge(GetAnalysisInputSchema);
const OrgListAnalysisJobsInputSchema = OrganizationIdInputSchema.merge(ListAnalysisJobsInputSchema);
const OrgDeleteFindingsByRepoInputSchema = OrganizationIdInputSchema.merge(
  DeleteFindingsByRepoInputSchema
);

/**
 * Security Agent Router for organizations
 */
export const organizationSecurityAgentRouter = createTRPCRouter({
  /**
   * Gets the GitHub App permission status for security reviews
   */
  getPermissionStatus: organizationMemberProcedure.query(async ({ input }) => {
    const integration = await getIntegrationForOrganization(input.organizationId, 'github');

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
  }),

  /**
   * Gets the security review configuration for organization
   */
  getConfig: organizationMemberProcedure.query(async ({ input, ctx }) => {
    const owner = { type: 'org' as const, id: input.organizationId, userId: ctx.user.id };
    const result = await getSecurityAgentConfigWithStatus(owner);

    if (!result) {
      // Return default configuration
      return {
        isEnabled: false,
        slaCriticalDays: 15,
        slaHighDays: 30,
        slaMediumDays: 45,
        slaLowDays: 90,
        autoSyncEnabled: true,
        repositorySelectionMode: 'selected' as const,
        selectedRepositoryIds: [] as number[],
        modelSlug: DEFAULT_SECURITY_AGENT_MODEL,
        // Auto-dismiss defaults (off by default)
        autoDismissEnabled: false,
        autoDismissConfidenceThreshold: 'high' as const,
      };
    }

    return {
      isEnabled: result.isEnabled,
      slaCriticalDays: result.config.sla_critical_days,
      slaHighDays: result.config.sla_high_days,
      slaMediumDays: result.config.sla_medium_days,
      slaLowDays: result.config.sla_low_days,
      autoSyncEnabled: result.config.auto_sync_enabled,
      repositorySelectionMode: result.config.repository_selection_mode || 'selected',
      selectedRepositoryIds: result.config.selected_repository_ids || [],
      modelSlug: result.config.model_slug || DEFAULT_SECURITY_AGENT_MODEL,
      // Auto-dismiss configuration
      autoDismissEnabled: result.config.auto_dismiss_enabled ?? false,
      autoDismissConfidenceThreshold: result.config.auto_dismiss_confidence_threshold ?? 'high',
    };
  }),

  /**
   * Saves the security review configuration for organization
   */
  saveConfig: organizationOwnerProcedure
    .input(OrgSaveSecurityConfigInputSchema)
    .mutation(async ({ input, ctx }) => {
      const owner = { type: 'org' as const, id: input.organizationId, userId: ctx.user.id };

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
          model_slug: input.modelSlug,
          // Auto-dismiss configuration
          auto_dismiss_enabled: input.autoDismissEnabled,
          auto_dismiss_confidence_threshold: input.autoDismissConfidenceThreshold,
        },
        ctx.user.id
      );

      trackSecurityAgentConfigSaved({
        distinctId: ctx.user.id,
        userId: ctx.user.id,
        organizationId: input.organizationId,
        autoSyncEnabled: input.autoSyncEnabled,
        autoDismissEnabled: input.autoDismissEnabled,
        autoDismissConfidenceThreshold: input.autoDismissConfidenceThreshold,
        modelSlug: input.modelSlug,
        repositorySelectionMode: input.repositorySelectionMode,
        selectedRepoCount: input.selectedRepositoryIds?.length,
      });

      return { success: true };
    }),

  /**
   * Enables or disables security reviews for organization.
   * When enabling, saves the repository selection and triggers an initial sync.
   */
  setEnabled: organizationOwnerProcedure
    .input(OrgSetEnabledInputSchema)
    .mutation(async ({ input, ctx }) => {
      const owner = { type: 'org' as const, id: input.organizationId, userId: ctx.user.id };
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

      console.log(
        `[security-agent] setEnabled called: isEnabled=${input.isEnabled}, organizationId=${input.organizationId}, selectionMode=${input.repositorySelectionMode}, selectedIds=${JSON.stringify(input.selectedRepositoryIds)}`
      );

      // Get integration (needed for both permission check and sync)
      const integration = await getIntegrationForOrganization(input.organizationId, 'github');

      // Check permissions before enabling
      if (input.isEnabled) {
        if (!integration || !hasSecurityReviewPermissions(integration)) {
          console.log(
            `[security-agent] Permission check failed: hasIntegration=${!!integration}, hasPermissions=${integration ? hasSecurityReviewPermissions(integration) : false}`
          );
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'GitHub App does not have vulnerability_alerts permission',
          });
        }
      }

      // Determine repository selection - use input if provided, otherwise use existing config or defaults
      const existingConfig = await getSecurityAgentConfigWithStatus(owner);
      const selectionMode =
        input.repositorySelectionMode ??
        existingConfig?.config.repository_selection_mode ??
        'selected';
      const selectedIds =
        input.selectedRepositoryIds ?? existingConfig?.config.selected_repository_ids ?? [];

      console.log(
        `[security-agent] Final selection: selectionMode=${selectionMode}, selectedIds=${JSON.stringify(selectedIds)}`
      );

      // Always upsert the config when enabling to ensure it exists with the correct selection
      if (input.isEnabled) {
        console.log(`[security-agent] Upserting config for organization ${input.organizationId}`);
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
      console.log(`[security-agent] Config enabled state set to: ${input.isEnabled}`);

      // When enabling, trigger an initial sync of repositories
      if (input.isEnabled && integration) {
        const installationId = integration.platform_installation_id;
        if (installationId) {
          const allRepos = integration.repositories || [];
          console.log(`[security-agent] Available repositories: ${allRepos.length}`);

          let repositoriesToSync: string[];

          if (selectionMode === 'all') {
            // Sync all repositories
            repositoriesToSync = allRepos
              .map(r => r.full_name)
              .filter((name): name is string => !!name);
          } else {
            // Sync only selected repositories
            repositoriesToSync = allRepos
              .filter(r => selectedIds.includes(r.id))
              .map(r => r.full_name)
              .filter((name): name is string => !!name);
          }

          console.log(
            `[security-agent] Repositories to sync: ${repositoriesToSync.length} - ${repositoriesToSync.join(', ')}`
          );

          if (repositoriesToSync.length > 0) {
            console.log(
              `[security-agent] Starting sync for ${repositoriesToSync.length} repositories`
            );
            const syncResult = await syncAllReposForOwner({
              owner: securityOwner,
              platformIntegrationId: integration.id,
              installationId,
              repositories: repositoriesToSync,
            });

            console.log(
              `[security-agent] Sync completed: synced=${syncResult.synced}, errors=${syncResult.errors}`
            );

            trackSecurityAgentEnabled({
              distinctId: ctx.user.id,
              userId: ctx.user.id,
              organizationId: input.organizationId,
              isEnabled: input.isEnabled,
              repositorySelectionMode: selectionMode,
              selectedRepoCount: repositoriesToSync.length,
              syncedCount: syncResult.synced,
              syncErrors: syncResult.errors,
            });

            return {
              success: true,
              syncResult: {
                synced: syncResult.synced,
                errors: syncResult.errors,
              },
            };
          } else {
            console.log(`[security-agent] No repositories to sync`);
          }
        } else {
          console.log(`[security-agent] No installation ID found`);
        }
      }

      const effectiveRepoCount =
        selectionMode === 'all'
          ? (integration?.repositories || []).filter(r => !!r.full_name).length
          : selectedIds.length;

      trackSecurityAgentEnabled({
        distinctId: ctx.user.id,
        userId: ctx.user.id,
        organizationId: input.organizationId,
        isEnabled: input.isEnabled,
        repositorySelectionMode: selectionMode,
        selectedRepoCount: effectiveRepoCount,
      });

      return { success: true };
    }),

  /**
   * Gets repositories available for security reviews.
   * Auto-fetches from GitHub if repositories are not cached.
   */
  getRepositories: organizationMemberProcedure.query(async ({ input }) => {
    const integration = await getIntegrationForOrganization(input.organizationId, 'github');

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
  }),

  /**
   * Lists security findings for organization
   */
  listFindings: organizationMemberProcedure
    .input(OrgListFindingsInputSchema)
    .query(async ({ input }) => {
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

      const findings = await listSecurityFindings({
        owner: securityOwner,
        repoFullName: input.repoFullName,
        status: input.status,
        severity: input.severity,
        exploitability: input.exploitability,
        suggestedAction: input.suggestedAction,
        analysisStatus: input.analysisStatus,
        limit: input.limit,
        offset: input.offset,
      });

      return findings;
    }),

  /**
   * Gets a single security finding by ID
   */
  getFinding: organizationMemberProcedure
    .input(OrgGetFindingInputSchema)
    .query(async ({ input }) => {
      const finding = await getSecurityFindingById(input.id);

      if (!finding) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Security finding not found',
        });
      }

      // Verify ownership
      if (finding.owned_by_organization_id !== input.organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this finding',
        });
      }

      return finding;
    }),

  /**
   * Gets security finding statistics for organization
   */
  getStats: organizationMemberProcedure.query(async ({ input }) => {
    const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };
    return await getSecurityFindingsSummary({ owner: securityOwner });
  }),

  /**
   * Gets the last sync time for security findings
   * Optionally filtered by repository
   */
  getLastSyncTime: organizationMemberProcedure
    .input(OrgListFindingsInputSchema.pick({ organizationId: true, repoFullName: true }))
    .query(async ({ input }) => {
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };
      const lastSyncTime = await getLastSyncTime({
        owner: securityOwner,
        repoFullName: input.repoFullName,
      });
      return { lastSyncTime };
    }),

  /**
   * Triggers a manual sync of Dependabot alerts.
   * If repoFullName is provided, syncs only that repository.
   * Otherwise, syncs all enabled repositories based on the config.
   */
  triggerSync: organizationMemberProcedure
    .input(OrgTriggerSyncInputSchema)
    .mutation(async ({ input, ctx }) => {
      const owner = { type: 'org' as const, id: input.organizationId, userId: ctx.user.id };
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

      // Get integration
      const integration = await getIntegrationForOrganization(input.organizationId, 'github');
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
          organizationId: input.organizationId,
          syncType: 'single_repo',
          repoCount: 1,
          synced: result.synced,
          errors: result.errors,
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
        organizationId: input.organizationId,
        syncType: 'all_repos',
        repoCount: repositoriesToSync.length,
        synced: result.synced,
        errors: result.errors,
      });

      return {
        success: true,
        synced: result.synced,
        errors: result.errors,
      };
    }),

  /**
   * Dismisses a security finding (marks as ignored and dismisses on GitHub)
   */
  dismissFinding: organizationOwnerProcedure
    .input(OrgDismissFindingInputSchema)
    .mutation(async ({ input, ctx }) => {
      // Get the finding
      const finding = await getSecurityFindingById(input.findingId);
      if (!finding) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Security finding not found',
        });
      }

      // Verify ownership
      if (finding.owned_by_organization_id !== input.organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this finding',
        });
      }

      // Get integration for GitHub API call
      const integration = await getIntegrationForOrganization(input.organizationId, 'github');
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
        organizationId: input.organizationId,
        findingId: input.findingId,
        reason: input.reason,
        source: finding.source,
        severity: finding.severity,
      });

      return { success: true };
    }),

  /**
   * Starts LLM analysis for a security finding (async - returns immediately)
   */
  startAnalysis: organizationMemberProcedure
    .input(OrgStartAnalysisInputSchema)
    .mutation(async ({ input, ctx }) => {
      const owner = { type: 'org' as const, id: input.organizationId, userId: ctx.user.id };
      const finding = await getSecurityFindingById(input.findingId);

      if (!finding) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Security finding not found',
        });
      }

      // Verify ownership
      if (finding.owned_by_organization_id !== input.organizationId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have access to this finding',
        });
      }

      // Check concurrency limit
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };
      const concurrencyCheck = await canStartAnalysis(securityOwner);

      if (!concurrencyCheck.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Maximum concurrent analyses reached (${concurrencyCheck.currentCount}/${concurrencyCheck.limit}). Please wait for existing analyses to complete.`,
        });
      }

      // Get GitHub token for the organization
      const githubToken = await getGitHubTokenForOrganization(input.organizationId);

      if (!githubToken) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'GitHub integration required for analysis',
        });
      }

      // Get model from input or fall back to configured model
      let model = input.model;
      if (!model) {
        const config = await getSecurityAgentConfigWithStatus(owner);
        model = config?.config.model_slug || DEFAULT_SECURITY_AGENT_MODEL;
      }

      const result = await startSecurityAnalysis({
        findingId: input.findingId,
        user: ctx.user,
        githubRepo: finding.repo_full_name,
        githubToken,
        model,
        forceSandbox: input.forceSandbox,
        organizationId: input.organizationId,
      });

      if (!result.started) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error || 'Failed to start analysis',
        });
      }

      return { success: true, triageOnly: result.triageOnly };
    }),

  /**
   * Gets the analysis status and result for a finding
   */
  getAnalysis: organizationMemberProcedure
    .input(OrgGetAnalysisInputSchema)
    .query(async ({ input }) => {
      const finding = await getSecurityFindingById(input.findingId);

      if (!finding) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Security finding not found',
        });
      }

      // Verify ownership
      if (finding.owned_by_organization_id !== input.organizationId) {
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
    }),

  /**
   * Lists findings with analysis status for the jobs view
   */
  listAnalysisJobs: organizationMemberProcedure
    .input(OrgListAnalysisJobsInputSchema)
    .query(async ({ input }) => {
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

      // Get findings that have been analyzed or are being analyzed
      const jobs = await listSecurityFindingsWithAnalysis({
        owner: securityOwner,
        limit: input.limit,
        offset: input.offset,
      });

      // Get total count for pagination
      const total = await countSecurityFindingsWithAnalysis(securityOwner);

      // Get concurrency info
      const concurrencyCheck = await canStartAnalysis(securityOwner);

      return {
        jobs,
        total,
        runningCount: concurrencyCheck.currentCount,
        concurrencyLimit: concurrencyCheck.limit,
      };
    }),

  /**
   * Gets repositories that have findings but are no longer accessible via the GitHub integration.
   * These are "orphaned" repositories that the organization may want to clean up.
   */
  getOrphanedRepositories: organizationMemberProcedure.query(async ({ input }) => {
    const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

    // Get the current GitHub integration
    const integration = await getIntegrationForOrganization(input.organizationId, 'github');

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
  }),

  /**
   * Deletes all security findings for a specific repository.
   * This is intended for cleaning up findings from repositories that are no longer accessible.
   */
  deleteFindingsByRepository: organizationOwnerProcedure
    .input(OrgDeleteFindingsByRepoInputSchema)
    .mutation(async ({ input }) => {
      const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

      const result = await deleteFindingsByRepository({
        owner: securityOwner,
        repoFullName: input.repoFullName,
      });

      return {
        success: true,
        deletedCount: result.deletedCount,
      };
    }),

  /**
   * Gets the count of findings eligible for auto-dismiss based on triage results.
   */
  getAutoDismissEligible: organizationMemberProcedure.query(async ({ input, ctx }) => {
    const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

    const result = await countEligibleForAutoDismiss(securityOwner, ctx.user.id);

    return {
      eligible: result.eligible,
      byConfidence: result.byConfidence,
    };
  }),

  /**
   * Auto-dismisses all eligible findings based on triage results.
   * Only works if auto-dismiss is enabled in config.
   */
  autoDismissEligible: organizationOwnerProcedure.mutation(async ({ input, ctx }) => {
    const securityOwner: SecurityReviewOwner = { organizationId: input.organizationId };

    const result = await autoDismissEligibleFindings(securityOwner, ctx.user.id);

    return {
      dismissed: result.dismissed,
      skipped: result.skipped,
      errors: result.errors,
    };
  }),
});
