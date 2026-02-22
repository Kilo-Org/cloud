/**
 * Security Reviews - Zod Validation Schemas
 *
 * Runtime validation schemas for security review inputs.
 * Follows validation patterns used throughout the codebase.
 */

import * as z from 'zod';

// ============================================================================
// Status and Severity Schemas
// ============================================================================

/**
 * Security finding status enum
 */
// NOTE: 'closed' is a UI-only filter value that maps to status IN ('fixed', 'ignored').
// It is not persisted in the database.
export const SecurityFindingStatusSchema = z.enum(['open', 'fixed', 'ignored', 'closed']);

/**
 * Security finding severity enum
 */
export const SecuritySeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

/**
 * Dependabot dismiss reason enum (matches GitHub API)
 */
export const DismissReasonSchema = z.enum([
  'fix_started',
  'no_bandwidth',
  'tolerable_risk',
  'inaccurate',
  'not_used',
]);

// ============================================================================
// tRPC Input Schemas
// ============================================================================

/**
 * Repository selection mode enum
 */
export const RepositorySelectionModeSchema = z.enum(['all', 'selected']);

/**
 * Auto-dismiss confidence threshold enum
 */
export const AutoDismissConfidenceThresholdSchema = z.enum(['high', 'medium', 'low']);

/**
 * Analysis mode enum
 */
export const AnalysisModeSchema = z.enum(['auto', 'shallow', 'deep']);

/**
 * Save security config input schema
 */
export const SaveSecurityConfigInputSchema = z.object({
  slaCriticalDays: z.number().min(1).max(365).optional(),
  slaHighDays: z.number().min(1).max(365).optional(),
  slaMediumDays: z.number().min(1).max(365).optional(),
  slaLowDays: z.number().min(1).max(365).optional(),
  autoSyncEnabled: z.boolean().optional(),
  repositorySelectionMode: RepositorySelectionModeSchema.optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
  modelSlug: z.string().optional(),
  // Analysis mode configuration
  analysisMode: AnalysisModeSchema.optional(),
  // Auto-dismiss configuration
  autoDismissEnabled: z.boolean().optional(),
  autoDismissConfidenceThreshold: AutoDismissConfidenceThresholdSchema.optional(),
});

/**
 * Exploitability filter enum for listing findings
 */
export const ExploitabilityFilterSchema = z.enum(['all', 'exploitable', 'not_exploitable']);

/**
 * Suggested action filter enum for listing findings
 * - dismissable: findings where triage or sandbox suggests 'dismiss'
 */
export const SuggestedActionFilterSchema = z.enum(['all', 'dismissable']);

/**
 * Analysis status filter enum for listing findings
 * - all: no filter
 * - not_analyzed: findings without any analysis (analysis_status is null)
 * - pending: analysis is pending
 * - running: analysis is currently running
 * - completed: analysis has completed
 * - failed: analysis failed
 */
export const AnalysisStatusFilterSchema = z.enum([
  'all',
  'not_analyzed',
  'pending',
  'running',
  'completed',
  'failed',
]);

/**
 * List security findings input schema
 */
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

/**
 * Trigger sync input schema
 * When repoFullName is not provided, syncs all enabled repositories
 */
export const TriggerSyncInputSchema = z.object({
  repoFullName: z.string().optional(),
});

/**
 * Dismiss finding input schema
 */
export const DismissFindingInputSchema = z.object({
  findingId: z.string().uuid(),
  reason: DismissReasonSchema,
  comment: z.string().optional(),
});

/**
 * Get finding input schema
 */
export const GetFindingInputSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Set enabled input schema
 * When enabling, optionally include repository selection to save with the config
 */
export const SetEnabledInputSchema = z.object({
  isEnabled: z.boolean(),
  // Optional repository selection - when provided, saves the config before enabling
  repositorySelectionMode: RepositorySelectionModeSchema.optional(),
  selectedRepositoryIds: z.array(z.number()).optional(),
});

// ============================================================================
// Analysis Schemas (Three-Tier: Triage + Sandbox + Extraction)
// ============================================================================

/**
 * Analysis status enum
 */
export const AnalysisStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

/**
 * Triage suggested action enum
 */
export const TriageSuggestedActionSchema = z.enum(['dismiss', 'analyze_codebase', 'manual_review']);

/**
 * Triage confidence level enum
 */
export const TriageConfidenceSchema = z.enum(['high', 'medium', 'low']);

/**
 * Schema for Tier 1 triage result (from metadata analysis)
 */
export const SecurityFindingTriageSchema = z.object({
  needsSandboxAnalysis: z.boolean(),
  needsSandboxReasoning: z.string(),
  suggestedAction: TriageSuggestedActionSchema,
  confidence: TriageConfidenceSchema,
  triageAt: z.string(),
});

/**
 * Sandbox suggested action enum (Tier 3 extraction)
 */
export const SandboxSuggestedActionSchema = z.enum([
  'dismiss', // Not exploitable in this codebase
  'open_pr', // Exploitable with clear fix - open a PR
  'manual_review', // Complex situation, needs human review
  'monitor', // Exploitable but low risk - keep open, low priority
]);

/**
 * Schema for Tier 2 sandbox analysis result (from cloud agent + Tier 3 extraction)
 */
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

/**
 * Schema for full analysis result (triage + optional sandbox)
 * Note: triage is optional for backwards compatibility with legacy data
 */
export const AnalysisResponseSchema = z.object({
  triage: SecurityFindingTriageSchema.optional(), // Optional for backwards compatibility
  sandboxAnalysis: SecurityFindingSandboxAnalysisSchema.optional(),
  rawMarkdown: z.string().optional(), // Present in legacy format or as fallback
  analyzedAt: z.string(),
  modelUsed: z.string().optional(),
  triggeredByUserId: z.string().optional(), // User ID who triggered the analysis (for audit tracking)
});

/**
 * Legacy schema for backwards compatibility with existing data
 * @deprecated Use AnalysisResponseSchema with triage field instead
 */
export const AnalysisResponseLegacySchema = z.object({
  rawMarkdown: z.string().min(1),
  analyzedAt: z.string(),
  modelUsed: z.string().optional(),
});

/**
 * Start analysis input schema
 */
export const StartAnalysisInputSchema = z.object({
  findingId: z.string().uuid(),
  model: z.string().optional(),
});

/**
 * Get analysis input schema
 */
export const GetAnalysisInputSchema = z.object({
  findingId: z.string().uuid(),
});

/**
 * List analysis jobs input schema
 */
export const ListAnalysisJobsInputSchema = z.object({
  limit: z.number().min(1).max(100).default(10),
  offset: z.number().min(0).default(0),
});

/**
 * Delete findings by repository input schema
 */
export const DeleteFindingsByRepoInputSchema = z.object({
  repoFullName: z.string().min(1),
});

// ============================================================================
// Inferred TypeScript Types from Zod Schemas
// ============================================================================

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
