import * as z from 'zod';

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

export const SaveSecurityConfigInputSchema = z.object({
  slaCriticalDays: z.number().min(1).max(365).optional(),
  slaHighDays: z.number().min(1).max(365).optional(),
  slaMediumDays: z.number().min(1).max(365).optional(),
  slaLowDays: z.number().min(1).max(365).optional(),
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
});

export const ExploitabilityFilterSchema = z.enum(['all', 'exploitable', 'not_exploitable']);
export const SuggestedActionFilterSchema = z.enum(['all', 'dismissable']);
export const AnalysisStatusFilterSchema = z.enum([
  'all',
  'not_analyzed',
  'pending',
  'running',
  'completed',
  'failed',
]);

export const ListFindingsInputSchema = z.object({
  repoFullName: z.string().optional(),
  status: SecurityFindingStatusSchema.optional(),
  severity: SecuritySeveritySchema.optional(),
  exploitability: ExploitabilityFilterSchema.optional(),
  suggestedAction: SuggestedActionFilterSchema.optional(),
  analysisStatus: AnalysisStatusFilterSchema.optional(),
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
  retrySandboxOnly: z.boolean().optional(),
});

export const GetAnalysisInputSchema = z.object({
  findingId: z.string().uuid(),
});

export const ListAnalysisJobsInputSchema = z.object({
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
});

export const DeleteFindingsByRepoInputSchema = z.object({
  repoFullName: z.string().min(1),
});

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
export type GetAnalysisInput = z.infer<typeof GetAnalysisInputSchema>;
export type ListAnalysisJobsInput = z.infer<typeof ListAnalysisJobsInputSchema>;
export type DeleteFindingsByRepoInput = z.infer<typeof DeleteFindingsByRepoInputSchema>;
