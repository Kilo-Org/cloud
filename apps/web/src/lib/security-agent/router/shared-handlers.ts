import type { TRPCContext } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import {
  type getIntegrationForOwner,
  updateRepositoriesForIntegration,
} from '@/lib/integrations/db/platform-integrations';
import { fetchGitHubRepositories } from '@/lib/integrations/platforms/github/adapter';
import { requireNumericPlatformRepositories } from '@/lib/integrations/core/types';
import {
  getSecurityAgentConfigWithStatus,
  upsertSecurityAgentConfig,
  setSecurityAgentEnabled,
} from '@/lib/security-agent/db/security-config';
import {
  listSecurityFindings,
  getSecurityFindingById,
  getSecurityFindingsSummary,
  getLastSyncTime as getLastSyncTimeDb,
  getOrphanedRepositoriesWithFindingCounts,
  deleteFindingsByRepository as deleteFindingsByRepositoryDb,
} from '@/lib/security-agent/db/security-findings';
import { getDashboardStats } from '@/lib/security-agent/db/dashboard-stats';
import {
  getSecurityAgentCommandStatus,
  listActiveSecurityAgentCommands,
  createApplyAutoRemediationCommand,
  markApplyAutoRemediationCommandAdmissionFailed,
} from '@/lib/security-agent/db/security-commands';
import {
  canStartAnalysis,
  enqueueBacklogFindings,
} from '@/lib/security-agent/db/security-analysis';
import {
  decorateFindingWithRemediation,
  decorateFindingsWithRemediation,
  getRemediationAttemptHistory,
} from '@/lib/security-agent/db/security-remediation';
import {
  SecurityAgentAuditReportInputSchema,
  SecurityAgentAuditReportQueryError,
  getSecurityAgentAuditReport,
  type SecurityAgentAuditReportInput,
  type SecurityAgentAuditReportOwner,
} from '@/lib/security-agent/db/security-audit-report';
import {
  hasSecurityReviewPermissions,
  getReauthorizeUrl,
} from '@/lib/security-agent/github/permissions';
import { submitManualSecuritySync } from '@/lib/security-agent/services/manual-sync-client';
import { submitManualFindingDismissal } from '@/lib/security-agent/services/manual-dismiss-client';
import { submitManualAnalysisStart } from '@/lib/security-agent/services/manual-analysis-client';
import {
  submitApplyAutoRemediation,
  submitManualRemediationStart,
  submitRemediationCancellation,
} from '@/lib/security-agent/services/manual-remediation-client';
import {
  autoDismissEligibleFindings,
  countEligibleForAutoDismiss,
} from '@/lib/security-agent/services/auto-dismiss-service';
import type { SecurityReviewOwner } from '@/lib/security-agent/core/types';
import { organizations, type SecurityFinding } from '@kilocode/db/schema';
import { buildSecurityFindingAuditHumanActor } from '@kilocode/worker-utils/security-finding-audit';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';
import {
  SaveSecurityConfigInputSchema,
  ListFindingsInputSchema,
  TriggerSyncInputSchema,
  DismissFindingInputSchema,
  GetFindingInputSchema,
  SetEnabledInputSchema,
  StartAnalysisInputSchema,
  StartRemediationInputSchema,
  RetryRemediationInputSchema,
  CancelRemediationInputSchema,
  GetAnalysisInputSchema,
  GetCommandStatusInputSchema,
  DeleteFindingsByRepoInputSchema,
  GetDashboardStatsInputSchema,
  TrackSecurityAgentUiInteractionInputSchema,
  type SaveSecurityConfigInput,
  type ListFindingsInput,
  type TriggerSyncInput,
  type DismissFindingInput,
  type GetFindingInput,
  type SetEnabledInput,
  type StartAnalysisInput,
  type StartRemediationInput,
  type RetryRemediationInput,
  type CancelRemediationInput,
  type GetAnalysisInput,
  type GetCommandStatusInput,
  type DeleteFindingsByRepoInput,
  type GetDashboardStatsInput,
  type TrackSecurityAgentUiInteractionInput,
} from '@/lib/security-agent/core/schemas';
import {
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  DEFAULT_SECURITY_AGENT_CONFIG,
} from '@/lib/security-agent/core/constants';
import {
  trackSecurityAgentEnabled,
  trackSecurityAgentConfigSaved,
  trackSecurityAgentSync,
  trackSecurityAgentFindingDismissed,
  trackSecurityAgentUiInteraction,
  trackSecurityAgentRemediationAction,
} from '@/lib/security-agent/posthog-tracking';
import {
  createSecurityAuditLog,
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
  trackingExtras: (ctx: TRPCContext, input: TExtra) => { organizationId?: string };
};

function getRepoFullNamesInScope(
  integration: Integration,
  config: { repository_selection_mode?: 'all' | 'selected'; selected_repository_ids?: number[] }
): string[] {
  const repositories = requireNumericPlatformRepositories(integration?.repositories ?? null) ?? [];
  if (config.repository_selection_mode === 'all') {
    return repositories.map(repo => repo.full_name).filter((name): name is string => !!name);
  }
  const selectedIds = new Set(config.selected_repository_ids ?? []);
  return repositories
    .filter(repo => selectedIds.has(repo.id))
    .map(repo => repo.full_name)
    .filter((name): name is string => !!name);
}

async function resolveAuditReportOwner(
  ctx: TRPCContext,
  owner: Owner
): Promise<SecurityAgentAuditReportOwner> {
  if (owner.type === 'user') {
    return {
      type: 'user',
      id: ctx.user.id,
      displayName: ctx.user.google_user_name || ctx.user.google_user_email || 'Personal owner',
    };
  }

  const [organization] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, owner.id))
    .limit(1);

  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }

  return {
    type: 'organization',
    id: owner.id,
    displayName: organization.name,
  };
}

async function logPlatformAdminAuditReportAccess(params: {
  ctx: TRPCContext;
  owner: SecurityAgentAuditReportOwner;
  periodStart: string;
  periodEndExclusive: string;
}): Promise<void> {
  if (!params.ctx.user.is_admin) return;

  const securityOwner =
    params.owner.type === 'organization'
      ? { organizationId: params.owner.id }
      : { userId: params.owner.id };

  await createSecurityAuditLog({
    owner: securityOwner,
    actor_id: params.ctx.user.id,
    actor_email: params.ctx.user.google_user_email,
    actor_name: params.ctx.user.google_user_name,
    action: SecurityAuditLogAction.AuditReportGenerated,
    resource_type: 'security_agent_audit_report',
    resource_id: `${params.owner.type}:${params.owner.id}`,
    metadata: {
      owner_type: params.owner.type,
      period_start: params.periodStart,
      period_end_exclusive: params.periodEndExclusive,
      report_version: 1,
    },
  });
}

async function assembleAuditReportResponse<TExtra>(params: {
  ctx: TRPCContext;
  input: SecurityAgentAuditReportInput & TExtra;
  deps: SecurityAgentDeps<TExtra>;
}): Promise<
  | { status: 'ok'; report: Awaited<ReturnType<typeof getSecurityAgentAuditReport>> }
  | { status: 'query_failed'; message: 'Report query did not finish' }
> {
  const owner = await resolveAuditReportOwner(
    params.ctx,
    params.deps.resolveOwner(params.ctx, params.input)
  );

  try {
    const report = await getSecurityAgentAuditReport({
      owner,
      input: params.input,
      isRequestingUserKiloAdmin: params.ctx.user.is_admin,
    });
    await logPlatformAdminAuditReportAccess({
      ctx: params.ctx,
      owner,
      periodStart: report.period.start,
      periodEndExclusive: report.period.endExclusive,
    });
    return { status: 'ok', report };
  } catch (error) {
    if (error instanceof SecurityAgentAuditReportQueryError) {
      return { status: 'query_failed', message: 'Report query did not finish' };
    }
    throw error;
  }
}

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
    trackUiInteraction: {
      inputSchema: TrackSecurityAgentUiInteractionInputSchema,
      handler: async ({
        ctx,
        input,
      }: {
        ctx: TRPCContext;
        input: TrackSecurityAgentUiInteractionInput & TExtra;
      }) => {
        trackSecurityAgentUiInteraction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          interaction: input.interaction,
        });

        return { success: true };
      },
    },

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
          authInvalidAt: integration?.auth_invalid_at ?? null,
          authInvalidReason: integration?.auth_invalid_reason ?? null,
        };
      }

      const hasPermissions = hasSecurityReviewPermissions(integration);
      // UI reauthorization state is intentionally time-invariant: once GitHub returns
      // auth-invalid, keep prompting until a sync or install-refresh path clears the flag.
      const hasEffectivePermissions = hasPermissions && !integration.auth_invalid_at;

      return {
        hasIntegration: true,
        hasPermissions: hasEffectivePermissions,
        reauthorizeUrl: hasEffectivePermissions
          ? null
          : integration.platform_installation_id
            ? getReauthorizeUrl(integration.platform_installation_id)
            : null,
        authInvalidAt: integration.auth_invalid_at,
        authInvalidReason: integration.auth_invalid_reason,
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
          hasConfig: false,
          isEnabled: false,
          slaCriticalDays: 15,
          slaHighDays: 30,
          slaMediumDays: 45,
          slaLowDays: 90,
          slaEnabled: DEFAULT_SECURITY_AGENT_CONFIG.sla_enabled,
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
          autoRemediationEnabled: false,
          autoRemediationMinSeverity: 'high' as const,
          autoRemediationIncludeExisting: false,
          autoRemediationEnabledAt: null,
          remediationModelSlug: DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
          slaNotificationsEnabled: DEFAULT_SECURITY_AGENT_CONFIG.sla_notifications_enabled,
          slaNotificationMinSeverity: DEFAULT_SECURITY_AGENT_CONFIG.sla_notification_min_severity,
          slaNotificationWarningDays: DEFAULT_SECURITY_AGENT_CONFIG.sla_notification_warning_days,
          newFindingNotificationsEnabled:
            DEFAULT_SECURITY_AGENT_CONFIG.new_finding_notifications_enabled,
          newFindingNotificationMinSeverity:
            DEFAULT_SECURITY_AGENT_CONFIG.new_finding_notification_min_severity,
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
      const remediationModelSlug =
        result.storedConfig.remediation_model_slug ??
        result.config.remediation_model_slug ??
        analysisModelSlug ??
        DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL;

      return {
        hasConfig: true,
        isEnabled: result.isEnabled,
        slaCriticalDays: result.config.sla_critical_days,
        slaHighDays: result.config.sla_high_days,
        slaMediumDays: result.config.sla_medium_days,
        slaLowDays: result.config.sla_low_days,
        slaEnabled: result.config.sla_enabled,
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
        autoRemediationEnabled: result.config.auto_remediation_enabled ?? false,
        autoRemediationMinSeverity: result.config.auto_remediation_min_severity ?? 'high',
        autoRemediationIncludeExisting: result.config.auto_remediation_include_existing ?? false,
        autoRemediationEnabledAt: result.config.auto_remediation_enabled_at ?? null,
        remediationModelSlug,
        slaNotificationsEnabled: result.config.sla_notifications_enabled,
        slaNotificationMinSeverity: result.config.sla_notification_min_severity,
        slaNotificationWarningDays: result.config.sla_notification_warning_days,
        newFindingNotificationsEnabled: result.config.new_finding_notifications_enabled,
        newFindingNotificationMinSeverity: result.config.new_finding_notification_min_severity,
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
              autoRemediationEnabled: existingConfig.config.auto_remediation_enabled,
              autoRemediationMinSeverity: existingConfig.config.auto_remediation_min_severity,
              autoRemediationIncludeExisting:
                existingConfig.config.auto_remediation_include_existing,
              autoRemediationEnabledAt: existingConfig.config.auto_remediation_enabled_at,
              remediationModelSlug:
                existingConfig.config.remediation_model_slug ?? existingAnalysisModelSlug,
              modelSlug: existingConfig.config.model_slug,
              triageModelSlug: existingTriageModelSlug,
              analysisModelSlug: existingAnalysisModelSlug,
              repositorySelectionMode: existingConfig.config.repository_selection_mode,
              selectedRepositoryIds: existingConfig.config.selected_repository_ids,
              slaCriticalDays: existingConfig.config.sla_critical_days,
              slaHighDays: existingConfig.config.sla_high_days,
              slaMediumDays: existingConfig.config.sla_medium_days,
              slaLowDays: existingConfig.config.sla_low_days,
              slaEnabled: existingConfig.config.sla_enabled,
              slaNotificationsEnabled: existingConfig.config.sla_notifications_enabled,
              slaNotificationMinSeverity: existingConfig.config.sla_notification_min_severity,
              slaNotificationWarningDays: existingConfig.config.sla_notification_warning_days,
              newFindingNotificationsEnabled:
                existingConfig.config.new_finding_notifications_enabled,
              newFindingNotificationMinSeverity:
                existingConfig.config.new_finding_notification_min_severity,
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
        const remediationModelSlug =
          input.remediationModelSlug ??
          existingConfig?.storedConfig.remediation_model_slug ??
          existingConfig?.config.remediation_model_slug ??
          analysisModelSlug;

        await upsertSecurityAgentConfig(
          owner,
          {
            sla_critical_days: input.slaCriticalDays,
            sla_high_days: input.slaHighDays,
            sla_medium_days: input.slaMediumDays,
            sla_low_days: input.slaLowDays,
            sla_enabled: input.slaEnabled,
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
            auto_remediation_enabled: input.autoRemediationEnabled,
            auto_remediation_min_severity: input.autoRemediationMinSeverity,
            auto_remediation_include_existing: input.autoRemediationIncludeExisting,
            remediation_model_slug: remediationModelSlug,
            sla_notifications_enabled: input.slaNotificationsEnabled,
            sla_notification_min_severity: input.slaNotificationMinSeverity,
            sla_notification_warning_days: input.slaNotificationWarningDays,
            new_finding_notifications_enabled: input.newFindingNotificationsEnabled,
            new_finding_notification_min_severity: input.newFindingNotificationMinSeverity,
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

        let existingFindingsQueuedCount: number | undefined;
        let backlogAdmissionWarning: string | undefined;
        if (isAutoAnalysisOn && (includeExistingJustTurnedOn || autoAnalysisReEnabled)) {
          try {
            existingFindingsQueuedCount = await enqueueBacklogFindings({
              owner: securityOwner,
              autoAnalysisMinSeverity:
                input.autoAnalysisMinSeverity ??
                existingConfig?.config.auto_analysis_min_severity ??
                'high',
            });
          } catch (error) {
            console.error('Failed to enqueue backlog findings', error);
            backlogAdmissionWarning =
              'Settings saved, but existing findings could not be queued. Retry saving settings.';
          }
        }

        const wasAutoRemediationOn = existingConfig?.config.auto_remediation_enabled ?? false;
        const isAutoRemediationOn =
          input.autoRemediationEnabled ?? existingConfig?.config.auto_remediation_enabled ?? false;
        const wasRemediationIncludeExisting =
          existingConfig?.config.auto_remediation_include_existing ?? false;
        const isNowRemediationIncludeExisting =
          input.autoRemediationIncludeExisting ?? wasRemediationIncludeExisting;
        const remediationIncludeExistingJustTurnedOn =
          isNowRemediationIncludeExisting && !wasRemediationIncludeExisting;
        const autoRemediationReEnabled =
          isAutoRemediationOn && !wasAutoRemediationOn && isNowRemediationIncludeExisting;
        const remediationThresholdChanged =
          isAutoRemediationOn &&
          isNowRemediationIncludeExisting &&
          !!input.autoRemediationMinSeverity &&
          input.autoRemediationMinSeverity !== existingConfig?.config.auto_remediation_min_severity;

        let existingRemediationCommandId: string | undefined;
        let remediationBacklogAdmissionWarning: string | undefined;
        if (
          isAutoRemediationOn &&
          (remediationIncludeExistingJustTurnedOn ||
            autoRemediationReEnabled ||
            remediationThresholdChanged)
        ) {
          const command = await createApplyAutoRemediationCommand(securityOwner);
          existingRemediationCommandId = command.id;
          try {
            await submitApplyAutoRemediation({
              commandId: command.id,
              owner: securityOwner,
              actorUserId: ctx.user.id,
            });
          } catch (error) {
            console.error('Failed to enqueue existing findings for remediation', error);
            remediationBacklogAdmissionWarning =
              'Settings saved, but existing exploitable findings could not be queued. Retry saving settings.';
            await markApplyAutoRemediationCommandAdmissionFailed(
              command.id,
              remediationBacklogAdmissionWarning
            );
          }
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
          remediationModelSlug,
          autoRemediationEnabled: input.autoRemediationEnabled,
          autoRemediationMinSeverity: input.autoRemediationMinSeverity,
          autoRemediationIncludeExisting: input.autoRemediationIncludeExisting,
          slaEnabled: input.slaEnabled,
          slaNotificationsEnabled: input.slaNotificationsEnabled,
          slaNotificationMinSeverity: input.slaNotificationMinSeverity,
          slaNotificationWarningDays: input.slaNotificationWarningDays,
          newFindingNotificationsEnabled: input.newFindingNotificationsEnabled,
          newFindingNotificationMinSeverity: input.newFindingNotificationMinSeverity,
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
            autoRemediationEnabled: input.autoRemediationEnabled,
            autoRemediationMinSeverity: input.autoRemediationMinSeverity,
            autoRemediationIncludeExisting: input.autoRemediationIncludeExisting,
            modelSlug,
            triageModelSlug,
            analysisModelSlug,
            remediationModelSlug,
            repositorySelectionMode: input.repositorySelectionMode,
            selectedRepositoryIds: input.selectedRepositoryIds,
            slaCriticalDays: input.slaCriticalDays,
            slaHighDays: input.slaHighDays,
            slaMediumDays: input.slaMediumDays,
            slaLowDays: input.slaLowDays,
            slaEnabled: input.slaEnabled,
            slaNotificationsEnabled: input.slaNotificationsEnabled,
            slaNotificationMinSeverity: input.slaNotificationMinSeverity,
            slaNotificationWarningDays: input.slaNotificationWarningDays,
            newFindingNotificationsEnabled: input.newFindingNotificationsEnabled,
            newFindingNotificationMinSeverity: input.newFindingNotificationMinSeverity,
          },
        });

        return {
          success: true,
          existingFindingsQueuedCount,
          backlogAdmissionWarning,
          existingRemediationCommandId,
          remediationBacklogAdmissionWarning,
        };
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
            const allRepos = requireNumericPlatformRepositories(integration.repositories) ?? [];

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
              let initialSync: Awaited<ReturnType<typeof submitManualSecuritySync>> | undefined;
              let initialSyncAdmissionFailed = false;
              try {
                initialSync = await submitManualSecuritySync({
                  owner: securityOwner,
                  actor: {
                    id: ctx.user.id,
                    email: ctx.user.google_user_email,
                    name: ctx.user.google_user_name,
                  },
                  origin: 'enable_initial_sync',
                });
              } catch (error) {
                initialSyncAdmissionFailed = true;
                console.error('Security Agent enabled but initial sync admission failed', error);
              }

              trackSecurityAgentEnabled({
                distinctId: ctx.user.id,
                userId: ctx.user.id,
                ...deps.trackingExtras(ctx, input),
                isEnabled: input.isEnabled,
                repositorySelectionMode: selectionMode,
                selectedRepoCount: repositoriesToSync.length,
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
                initialSync,
                initialSyncAdmissionFailed,
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
      let repos = requireNumericPlatformRepositories(integration.repositories) ?? [];
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
        const owner = deps.resolveOwner(ctx, input);
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
        const [configWithStatus, integration] = await Promise.all([
          getSecurityAgentConfigWithStatus(owner),
          deps.getIntegration(ctx, input),
        ]);
        const config = configWithStatus?.config ?? DEFAULT_SECURITY_AGENT_CONFIG;
        const decoratedFindings = await decorateFindingsWithRemediation({
          findings,
          config,
          isAgentEnabled: configWithStatus?.isEnabled ?? false,
          repoFullNamesInScope: getRepoFullNamesInScope(integration, config),
        });

        return {
          findings: decoratedFindings,
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
        const owner = deps.resolveOwner(ctx, input);
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

        const [configWithStatus, integration] = await Promise.all([
          getSecurityAgentConfigWithStatus(owner),
          deps.getIntegration(ctx, input),
        ]);
        const config = configWithStatus?.config ?? DEFAULT_SECURITY_AGENT_CONFIG;
        return decorateFindingWithRemediation({
          finding,
          config,
          isAgentEnabled: configWithStatus?.isEnabled ?? false,
          repoFullNamesInScope: getRepoFullNamesInScope(integration, config),
        });
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

        const allRepos = requireNumericPlatformRepositories(integration.repositories) ?? [];

        // If a specific repo is provided, sync only that one
        if (input.repoFullName) {
          const hasRepo = allRepos.some(r => r.full_name === input.repoFullName);
          if (!hasRepo) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'Repository not found in your GitHub integration',
            });
          }

          const accepted = await submitManualSecuritySync({
            owner: securityOwner,
            actor: {
              id: ctx.user.id,
              email: ctx.user.google_user_email,
              name: ctx.user.google_user_name,
            },
            origin: 'dashboard_refresh',
            repoFullName: input.repoFullName,
          });

          trackSecurityAgentSync({
            distinctId: ctx.user.id,
            userId: ctx.user.id,
            ...deps.trackingExtras(ctx, input),
            syncType: 'single_repo',
            repoCount: 1,
            synced: 0,
            errors: 0,
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
              runId: accepted.runId,
              messageId: accepted.messageId,
              status: 'accepted',
            },
          });

          return {
            success: true,
            ...accepted,
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

        const accepted = await submitManualSecuritySync({
          owner: securityOwner,
          actor: {
            id: ctx.user.id,
            email: ctx.user.google_user_email,
            name: ctx.user.google_user_name,
          },
          origin: 'dashboard_refresh',
        });

        trackSecurityAgentSync({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          ...deps.trackingExtras(ctx, input),
          syncType: 'all_repos',
          repoCount: repositoriesToSync.length,
          synced: 0,
          errors: 0,
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
            runId: accepted.runId,
            messageId: accepted.messageId,
            status: 'accepted',
          },
        });

        return {
          success: true,
          ...accepted,
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

        const accepted = await submitManualFindingDismissal({
          owner: securityOwner,
          actor: { id: ctx.user.id },
          findingId: input.findingId,
          installationId,
          reason: input.reason,
          comment: input.comment,
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

        return { success: true, ...accepted };
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

        if (input.restartActive && finding.analysis_status !== 'running') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Only a running Sandbox Analysis can be restarted',
          });
        }

        if (!input.restartActive) {
          const concurrencyCheck = await canStartAnalysis(securityOwner);

          if (!concurrencyCheck.allowed) {
            throw new TRPCError({
              code: 'TOO_MANY_REQUESTS',
              message: `Maximum concurrent analyses reached (${concurrencyCheck.currentCount}/${concurrencyCheck.limit}). Please wait for existing analyses to complete.`,
            });
          }
        }

        const queued = await submitManualAnalysisStart({
          findingId: input.findingId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
          requestedModels: {
            model: input.model,
            triageModel: input.triageModel,
            analysisModel: input.analysisModel,
          },
          forceSandbox: input.forceSandbox,
          retrySandboxOnly: input.retrySandboxOnly,
          restartActive: input.restartActive,
        });

        return { success: true, ...queued };
      },
    },

    // -----------------------------------------------------------------------
    // 13. startRemediation
    // -----------------------------------------------------------------------
    startRemediation: {
      inputSchema: StartRemediationInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: StartRemediationInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const finding = await getSecurityFindingById(input.findingId);

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

        const queued = await submitManualRemediationStart({
          findingId: input.findingId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
        });
        if (!queued.queued) return { success: false, ...queued };

        trackSecurityAgentRemediationAction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          action: 'start',
        });

        return { success: true, ...queued };
      },
    },

    // -----------------------------------------------------------------------
    // 14. retryRemediation
    // -----------------------------------------------------------------------
    retryRemediation: {
      inputSchema: RetryRemediationInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: RetryRemediationInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const finding = await getSecurityFindingById(input.findingId);

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

        const queued = await submitManualRemediationStart({
          findingId: input.findingId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
          retry: true,
        });
        if (!queued.queued) return { success: false, ...queued };

        trackSecurityAgentRemediationAction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          action: 'retry',
        });

        return { success: true, ...queued };
      },
    },

    // -----------------------------------------------------------------------
    // 15. cancelRemediation
    // -----------------------------------------------------------------------
    cancelRemediation: {
      inputSchema: CancelRemediationInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: CancelRemediationInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const result = await submitRemediationCancellation({
          attemptId: input.attemptId,
          owner: securityOwner,
          actorUserId: ctx.user.id,
        });

        trackSecurityAgentRemediationAction({
          distinctId: ctx.user.id,
          userId: ctx.user.id,
          organizationId: deps.trackingExtras(ctx, input).organizationId,
          action: 'cancel',
        });

        return result;
      },
    },

    // -----------------------------------------------------------------------
    // 16. getAnalysis
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

        const owner = deps.resolveOwner(ctx, input);
        const [configWithStatus, integration, remediationAttempts] = await Promise.all([
          getSecurityAgentConfigWithStatus(owner),
          deps.getIntegration(ctx, input),
          getRemediationAttemptHistory(input.findingId),
        ]);
        const config = configWithStatus?.config ?? DEFAULT_SECURITY_AGENT_CONFIG;
        const decoratedFinding = await decorateFindingWithRemediation({
          finding,
          config,
          isAgentEnabled: configWithStatus?.isEnabled ?? false,
          repoFullNamesInScope: getRepoFullNamesInScope(integration, config),
        });

        return {
          findingState: {
            status: finding.status,
            ignoredReason: finding.ignored_reason,
            ignoredBy: finding.ignored_by,
            fixedAt: finding.fixed_at,
            updatedAt: finding.updated_at,
          },
          status: finding.analysis_status,
          startedAt: finding.analysis_started_at,
          completedAt: finding.analysis_completed_at,
          error: finding.analysis_error,
          analysis: finding.analysis,
          sessionId: finding.session_id,
          cliSessionId: finding.cli_session_id,
          remediationSummary: decoratedFinding.remediationSummary ?? null,
          remediationCapability: decoratedFinding.remediationCapability,
          remediationAttempts,
        };
      },
    },

    // -----------------------------------------------------------------------
    // 17. getCommandStatus
    // -----------------------------------------------------------------------
    getCommandStatus: {
      inputSchema: GetCommandStatusInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: GetCommandStatusInput & TExtra;
      }) => {
        const input = rawInput;
        const securityOwner = deps.resolveSecurityOwner(ctx, input);
        const command = await getSecurityAgentCommandStatus(securityOwner, input.commandId);
        if (!command) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Security Agent command not found' });
        }
        return command;
      },
    },

    // -----------------------------------------------------------------------
    // 18. listActiveCommands
    // -----------------------------------------------------------------------
    listActiveCommands: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      return listActiveSecurityAgentCommands(deps.resolveSecurityOwner(ctx, extra));
    },

    // -----------------------------------------------------------------------
    // 19. getOrphanedRepositories
    // -----------------------------------------------------------------------
    getOrphanedRepositories: async ({ ctx, input }: { ctx: TRPCContext; input: unknown }) => {
      const extra = toExtra(input);
      const securityOwner = deps.resolveSecurityOwner(ctx, extra);

      // Get the current GitHub integration
      const integration = await deps.getIntegration(ctx, extra);

      // Get list of accessible repository full names
      const accessibleRepoFullNames: string[] = [];
      if (integration && integration.integration_status === 'active') {
        const repos = requireNumericPlatformRepositories(integration.repositories) ?? [];
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
          actor: buildSecurityFindingAuditHumanActor({
            id: ctx.user.id,
            email: ctx.user.google_user_email,
            name: ctx.user.google_user_name,
            isAdmin: ctx.user.is_admin,
          }),
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
      const result = await autoDismissEligibleFindings(
        securityOwner,
        buildSecurityFindingAuditHumanActor({
          id: ctx.user.id,
          email: ctx.user.google_user_email,
          name: ctx.user.google_user_name,
          isAdmin: ctx.user.is_admin,
        })
      );

      return {
        dismissed: result.dismissed,
        skipped: result.skipped,
        errors: result.errors,
      };
    },

    // -----------------------------------------------------------------------
    // 18. getAuditReport
    // -----------------------------------------------------------------------
    getAuditReport: {
      inputSchema: SecurityAgentAuditReportInputSchema,
      handler: async ({
        ctx,
        input: rawInput,
      }: {
        ctx: TRPCContext;
        input: SecurityAgentAuditReportInput & TExtra;
      }) => {
        return assembleAuditReportResponse({
          ctx,
          input: rawInput,
          deps,
        });
      },
    },

    // -----------------------------------------------------------------------
    // 19. getDashboardStats
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
          slaEnabled: config?.config.sla_enabled ?? true,
          slaConfig,
        });
      },
    },
  };
}
