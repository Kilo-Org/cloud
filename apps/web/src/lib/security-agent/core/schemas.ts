import * as z from 'zod';
import {
  SecurityNotificationSeveritySchema,
  SecurityNotificationWarningDaysSchema,
} from '@kilocode/worker-utils/security-notification-policy';

// 'closed' is a UI-only filter that maps to status IN ('fixed', 'ignored').
export const SecurityFindingStatusSchema = z.enum(['open', 'fixed', 'ignored', 'closed']);

export const SecuritySeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

/** Matches GitHub API dismiss reasons. */
export const DismissReasonSchema = z.enum([
  'fix_started',
  'no_bandwidth',
  'tolerable_risk',
  'inaccurate',
  'not_used',
]);

export const RepositorySelectionModeSchema = z.enum(['all', 'selected']);
export const AutoDismissConfidenceThresholdSchema = z.enum(['high', 'medium', 'low']);
export const AnalysisModeSchema = z.enum(['auto', 'shallow', 'deep']);
export const AutoAnalysisMinSeveritySchema = z.enum(['critical', 'high', 'medium', 'all']);
export const AutoRemediationMinSeveritySchema = z.enum(['critical', 'high', 'medium', 'all']);
export const NotificationMinSeveritySchema = SecurityNotificationSeveritySchema;
export const SecurityAgentUiInteractionSchema = z.enum([
  'finding_detail_opened',
  'finding_triage_viewed',
  'finding_analysis_viewed',
  'finding_remediation_viewed',
  'findings_filtered',
  'settings_config_viewed',
  'settings_automation_viewed',
  'settings_notifications_viewed',
  'settings_sla_viewed',
]);

export const TrackSecurityAgentUiInteractionInputSchema = z.object({
  interaction: SecurityAgentUiInteractionSchema,
});

export const SaveSecurityConfigInputSchema = z.object({
  slaCriticalDays: z.number().min(1).max(365).optional(),
  slaHighDays: z.number().min(1).max(365).optional(),
  slaMediumDays: z.number().min(1).max(365).optional(),
  slaLowDays: z.number().min(1).max(365).optional(),
  slaEnabled: z.boolean().optional(),
  autoSyncEnabled: z.boolean().optional(),
  repositorySelectionMode: RepositorySelectionModeSchema.optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
  modelSlug: z.string().optional(),
  triageModelSlug: z.string().optional(),
  analysisModelSlug: z.string().optional(),
  analysisMode: AnalysisModeSchema.optional(),
  autoDismissEnabled: z.boolean().optional(),
  autoDismissConfidenceThreshold: AutoDismissConfidenceThresholdSchema.optional(),
  autoAnalysisEnabled: z.boolean().optional(),
  autoAnalysisMinSeverity: AutoAnalysisMinSeveritySchema.optional(),
  autoAnalysisIncludeExisting: z.boolean().optional(),
  autoRemediationEnabled: z.boolean().optional(),
  autoRemediationMinSeverity: AutoRemediationMinSeveritySchema.optional(),
  autoRemediationIncludeExisting: z.boolean().optional(),
  remediationModelSlug: z.string().optional(),
  slaNotificationsEnabled: z.boolean().optional(),
  slaNotificationMinSeverity: NotificationMinSeveritySchema.optional(),
  slaNotificationWarningDays: SecurityNotificationWarningDaysSchema.optional(),
  newFindingNotificationsEnabled: z.boolean().optional(),
  newFindingNotificationMinSeverity: NotificationMinSeveritySchema.optional(),
});

export const OutcomeFilterSchema = z.enum([
  'all',
  'not_analyzed',
  'analyzing',
  'failed',
  'exploitable',
  'not_exploitable',
  'safe_to_dismiss',
  'needs_review',
  'triage_complete',
  'fixed',
  'dismissed',
]);

export const ListFindingsInputSchema = z.object({
  repoFullName: z.string().optional(),
  status: SecurityFindingStatusSchema.optional(),
  severity: SecuritySeveritySchema.optional(),
  outcomeFilter: OutcomeFilterSchema.optional(),
  overdue: z.boolean().optional(),
  sortBy: z.enum(['severity_desc', 'severity_asc', 'sla_due_at_asc']).default('severity_desc'),
  limit: z.number().min(1).max(100).default(50),
  offset: z.number().min(0).default(0),
});

export const TriggerSyncInputSchema = z.object({
  repoFullName: z.string().optional(),
});

export const DismissFindingInputSchema = z.object({
  findingId: z.string().uuid(),
  reason: DismissReasonSchema,
  comment: z.string().optional(),
});

export const GetFindingInputSchema = z.object({
  id: z.string().uuid(),
});

export const SetEnabledInputSchema = z.object({
  isEnabled: z.boolean(),
  repositorySelectionMode: RepositorySelectionModeSchema.optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
});

export const AnalysisStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export const TriageSuggestedActionSchema = z.enum(['dismiss', 'analyze_codebase', 'manual_review']);
export const TriageConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const SecurityFindingTriageSchema = z.object({
  needsSandboxAnalysis: z.boolean(),
  needsSandboxReasoning: z.string(),
  suggestedAction: TriageSuggestedActionSchema,
  confidence: TriageConfidenceSchema,
  triageAt: z.string(),
});

export const SandboxSuggestedActionSchema = z.enum([
  'dismiss',
  'open_pr',
  'manual_review',
  'monitor',
]);

export const SecurityFindingSandboxAnalysisSchema = z.object({
  isExploitable: z.union([z.boolean(), z.literal('unknown')]),
  extractionStatus: z.enum(['succeeded', 'failed']).optional(),
  exploitabilityReasoning: z.string(),
  usageLocations: z.array(z.string()),
  suggestedFix: z.string(),
  suggestedAction: SandboxSuggestedActionSchema,
  summary: z.string(),
  rawMarkdown: z.string(),
  analysisAt: z.string(),
  modelUsed: z.string().optional(),
});

export const AnalysisResponseSchema = z.object({
  triage: SecurityFindingTriageSchema.optional(),
  sandboxAnalysis: SecurityFindingSandboxAnalysisSchema.optional(),
  rawMarkdown: z.string().optional(),
  analyzedAt: z.string(),
  modelUsed: z.string().optional(),
  triageModel: z.string().optional(),
  analysisModel: z.string().optional(),
  triggeredByUserId: z.string().optional(),
});

/** @deprecated Use AnalysisResponseSchema with triage field instead. */
export const AnalysisResponseLegacySchema = z.object({
  rawMarkdown: z.string().min(1),
  analyzedAt: z.string(),
  modelUsed: z.string().optional(),
});

export const StartAnalysisInputSchema = z.object({
  findingId: z.string().uuid(),
  model: z.string().optional(),
  triageModel: z.string().optional(),
  analysisModel: z.string().optional(),
  forceSandbox: z.boolean().optional(),
  retrySandboxOnly: z.boolean().optional(),
  restartActive: z.boolean().optional(),
});

export const StartRemediationInputSchema = z.object({
  findingId: z.string().uuid(),
});

export const RetryRemediationInputSchema = z.object({
  findingId: z.string().uuid(),
});

export const CancelRemediationInputSchema = z.object({
  attemptId: z.string().uuid(),
});

export const GetAnalysisInputSchema = z.object({
  findingId: z.string().uuid(),
});

export const GetCommandStatusInputSchema = z.object({
  commandId: z.string().uuid(),
});

export const DeleteFindingsByRepoInputSchema = z.object({
  repoFullName: z.string().min(1),
});

export const GetDashboardStatsInputSchema = z.object({
  repoFullName: z.string().optional(),
});

export type SecurityAgentUiInteraction = z.infer<typeof SecurityAgentUiInteractionSchema>;
export type TrackSecurityAgentUiInteractionInput = z.infer<
  typeof TrackSecurityAgentUiInteractionInputSchema
>;
export type SaveSecurityConfigInput = z.infer<typeof SaveSecurityConfigInputSchema>;
export type ListFindingsInput = z.infer<typeof ListFindingsInputSchema>;
export type TriggerSyncInput = z.infer<typeof TriggerSyncInputSchema>;
export type DismissFindingInput = z.infer<typeof DismissFindingInputSchema>;
export type GetFindingInput = z.infer<typeof GetFindingInputSchema>;
export type SetEnabledInput = z.infer<typeof SetEnabledInputSchema>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
export type AnalysisResponseLegacy = z.infer<typeof AnalysisResponseLegacySchema>;
export type SecurityFindingTriageResponse = z.infer<typeof SecurityFindingTriageSchema>;
export type SecurityFindingSandboxAnalysisResponse = z.infer<
  typeof SecurityFindingSandboxAnalysisSchema
>;
export type StartAnalysisInput = z.infer<typeof StartAnalysisInputSchema>;
export type StartRemediationInput = z.infer<typeof StartRemediationInputSchema>;
export type RetryRemediationInput = z.infer<typeof RetryRemediationInputSchema>;
export type CancelRemediationInput = z.infer<typeof CancelRemediationInputSchema>;
export type GetAnalysisInput = z.infer<typeof GetAnalysisInputSchema>;
export type GetCommandStatusInput = z.infer<typeof GetCommandStatusInputSchema>;
export type DeleteFindingsByRepoInput = z.infer<typeof DeleteFindingsByRepoInputSchema>;
export type GetDashboardStatsInput = z.infer<typeof GetDashboardStatsInputSchema>;
