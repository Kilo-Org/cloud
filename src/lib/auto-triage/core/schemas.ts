/**
 * Auto Triage - Zod Validation Schemas
 *
 * Runtime validation schemas for auto triage inputs and outputs.
 * Follows validation patterns used throughout the codebase.
 */

import * as z from 'zod';
import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/model-constants';
import type { AutoTriageTicket } from '@/db/schema';
import { AUTO_TRIAGE_CONSTANTS } from './constants';

// ============================================================================
// Status and Ownership Schemas
// ============================================================================

/**
 * Auto triage ticket status enum
 */
export const TriageStatusSchema = z.enum(['pending', 'analyzing', 'actioned', 'failed', 'skipped']);

/**
 * Classification types for issues
 */
export const ClassificationTypeSchema = z.enum([
  'bug',
  'feature',
  'question',
  'duplicate',
  'unclear',
]);

/**
 * Action taken on a ticket
 */
export const ActionTakenSchema = z.enum([
  'pr_created',
  'comment_posted',
  'closed_duplicate',
  'needs_clarification',
]);

/**
 * Owner schema - discriminated union
 */
export const OwnerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('org'),
    id: z.string().uuid(),
    userId: z.string(),
  }),
  z.object({
    type: z.literal('user'),
    id: z.string(),
    userId: z.string(),
  }),
]);

// ============================================================================
// Configuration Schemas
// ============================================================================

/**
 * Auto triage agent configuration schema
 * Used for storing configuration in agent_configs table
 */
export const AutoTriageAgentConfigSchema = z
  .object({
    enabled_for_issues: z.boolean().describe('Enable auto triage for GitHub issues'),
    repository_selection_mode: z
      .enum(['all', 'selected'])
      .describe('Whether to triage all repositories or only selected ones'),
    selected_repository_ids: z
      .array(z.number().int().positive())
      .default([])
      .describe('List of repository IDs to enable auto triage for (when mode is "selected")'),
    skip_labels: z
      .array(z.string())
      .default([])
      .describe('Issue labels that should skip auto triage'),
    required_labels: z
      .array(z.string())
      .default([])
      .describe('Issue labels that must be present for auto triage to proceed'),
    duplicate_threshold: z
      .number()
      .min(0)
      .max(1)
      .default(AUTO_TRIAGE_CONSTANTS.DEFAULT_DUPLICATE_THRESHOLD)
      .describe('Similarity threshold for duplicate detection (0-1)'),
    auto_fix_threshold: z
      .number()
      .min(0)
      .max(1)
      .default(AUTO_TRIAGE_CONSTANTS.DEFAULT_AUTO_PR_THRESHOLD)
      .describe('Confidence threshold for automatically adding kilo-auto-fix label (0-1)'),
    max_concurrent_per_owner: z
      .number()
      .int()
      .positive()
      .default(AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER)
      .describe('Maximum concurrent triage operations per owner'),
    custom_instructions: z
      .string()
      .nullable()
      .optional()
      .describe('Custom instructions for the triage agent'),
    model_slug: z
      .string()
      .default(CLAUDE_SONNET_CURRENT_MODEL_ID)
      .describe('Model to use for classification and analysis'),
    max_classification_time_minutes: z
      .number()
      .int()
      .positive()
      .min(1)
      .max(15)
      .default(5)
      .describe('Maximum time for issue classification (1-15 minutes)'),
    // Deprecated fields (kept for backward compatibility)
    auto_create_pr_threshold: z.number().min(0).max(1).optional(),
    pr_branch_prefix: z.string().optional(),
    pr_title_template: z.string().optional(),
    pr_body_template: z.string().optional(),
    pr_base_branch: z.string().optional(),
    max_pr_creation_time_minutes: z.number().int().positive().min(5).max(30).optional(),
  })
  .strict();

/**
 * Schema for saving auto triage configuration via tRPC
 */
export const SaveAutoTriageConfigSchema = z
  .object({
    organizationId: z.string().uuid(),
    enabled_for_issues: z.boolean(),
    repository_selection_mode: z.enum(['all', 'selected']),
    selected_repository_ids: z.array(z.number().int().positive()).optional(),
    skip_labels: z.array(z.string()).optional(),
    required_labels: z.array(z.string()).optional(),
    duplicate_threshold: z.number().min(0).max(1).optional(),
    auto_fix_threshold: z.number().min(0).max(1).optional(),
    max_concurrent_per_owner: z.number().int().positive().optional(),
    custom_instructions: z.string().nullable().optional(),
    model_slug: z.string().optional(),
    max_classification_time_minutes: z.number().int().positive().min(1).max(15).optional(),
    // Deprecated fields (kept for backward compatibility)
    auto_create_pr_threshold: z.number().min(0).max(1).optional(),
    pr_branch_prefix: z.string().optional(),
    pr_title_template: z.string().optional(),
    pr_body_template: z.string().optional(),
    pr_base_branch: z.string().optional(),
    max_pr_creation_time_minutes: z.number().int().positive().min(5).max(30).optional(),
  })
  .strict();

// ============================================================================
// GitHub Webhook Schemas
// ============================================================================

/**
 * GitHub user schema
 */
const GitHubUserSchema = z.object({
  login: z.string(),
  type: z.string().optional(),
});

/**
 * GitHub repository schema
 */
export const GitHubRepositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  private: z.boolean(),
});

/**
 * GitHub label schema (can be string or object)
 */
const GitHubLabelSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
  }),
]);

/**
 * GitHub issue schema
 */
export const GitHubIssueSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  title: z.string(),
  body: z.string().nullable(),
  user: GitHubUserSchema,
  labels: z.array(GitHubLabelSchema).optional(),
});

/**
 * GitHub issue webhook payload
 * Actions: opened, reopened, edited
 */
export const WebhookIssuePayloadSchema = z.object({
  action: z.enum(['opened', 'reopened', 'edited']),
  issue: GitHubIssueSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubUserSchema,
});

// ============================================================================
// Database Operation Schemas
// ============================================================================

/**
 * Create ticket params schema
 */
export const CreateTicketParamsSchema = z.object({
  owner: OwnerSchema,
  platformIntegrationId: z.string().uuid().optional(),
  repoFullName: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueUrl: z.string().url(),
  issueTitle: z.string().min(1),
  issueBody: z.string().nullable(),
  issueAuthor: z.string().min(1),
  issueType: z.enum(['issue', 'pull_request']),
  issueLabels: z.array(z.string()).default([]),
});

/**
 * Update ticket status params schema
 */
export const UpdateTicketStatusParamsSchema = z.object({
  ticketId: z.string().uuid(),
  status: TriageStatusSchema,
  sessionId: z.string().optional(),
  classification: ClassificationTypeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  intentSummary: z.string().optional(),
  relatedFiles: z.array(z.string()).optional(),
  isDuplicate: z.boolean().optional(),
  duplicateOfTicketId: z.string().uuid().optional(),
  similarityScore: z.number().min(0).max(1).optional(),
  qdrantPointId: z.string().optional(),
  actionTaken: ActionTakenSchema.optional(),
  actionMetadata: z.record(z.string(), z.unknown()).optional(),
  errorMessage: z.string().optional(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
});

/**
 * List tickets params schema
 */
export const ListTicketsParamsSchema = z.object({
  owner: OwnerSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUTO_TRIAGE_CONSTANTS.MAX_PAGE_SIZE)
    .default(AUTO_TRIAGE_CONSTANTS.DEFAULT_PAGE_SIZE),
  offset: z.number().int().min(0).default(0),
  status: TriageStatusSchema.optional(),
  classification: ClassificationTypeSchema.optional(),
  repoFullName: z.string().optional(),
});

// ============================================================================
// tRPC Input Schemas
// ============================================================================

/**
 * List triage tickets input (for organizations)
 */
export const ListTriageTicketsInputSchema = z.object({
  organizationId: z.string().uuid(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUTO_TRIAGE_CONSTANTS.MAX_PAGE_SIZE)
    .default(AUTO_TRIAGE_CONSTANTS.DEFAULT_PAGE_SIZE)
    .optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: TriageStatusSchema.optional(),
  classification: ClassificationTypeSchema.optional(),
  repoFullName: z.string().optional(),
});

/**
 * List triage tickets input (for personal users)
 */
export const ListTriageTicketsForUserInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUTO_TRIAGE_CONSTANTS.MAX_PAGE_SIZE)
    .default(AUTO_TRIAGE_CONSTANTS.DEFAULT_PAGE_SIZE)
    .optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: TriageStatusSchema.optional(),
  classification: ClassificationTypeSchema.optional(),
  repoFullName: z.string().optional(),
});

/**
 * Get triage ticket input
 */
export const GetTriageTicketInputSchema = z.object({
  ticketId: z.string().uuid(),
});

/**
 * Retrigger triage ticket input
 */
export const RetriggerTriageTicketInputSchema = z.object({
  ticketId: z.string().uuid(),
});

/**
 * Get auto triage config input
 */
export const GetAutoTriageConfigInputSchema = z.object({
  organizationId: z.string().uuid(),
});

// ============================================================================
// Classification Result Schemas
// ============================================================================

/**
 * Classification result from LLM analysis
 */
export const ClassificationResultSchema = z.object({
  classification: ClassificationTypeSchema,
  confidence: z.number().min(0).max(1).describe('Confidence score (0-1)'),
  intentSummary: z.string().describe('Summary of the issue intent'),
  relatedFiles: z.array(z.string()).optional().describe('Files potentially related to this issue'),
  reasoning: z.string().optional().describe('Explanation of the classification'),
  suggestedAction: z.string().optional().describe('Suggested action to take on this issue'),
});

// ============================================================================
// Duplicate Detection Result Schemas
// ============================================================================

/**
 * Similar ticket found during duplicate detection
 */
export const SimilarTicketSchema = z.object({
  ticketId: z.string().uuid(),
  issueNumber: z.number().int().positive(),
  issueTitle: z.string(),
  similarity: z.number().min(0).max(1).describe('Cosine similarity score'),
  repoFullName: z.string(),
});

/**
 * Duplicate detection result
 */
export const DuplicateDetectionResultSchema = z.object({
  isDuplicate: z.boolean(),
  duplicateOfTicketId: z.string().uuid().nullable(),
  similarityScore: z.number().min(0).max(1).nullable(),
  similarTickets: z.array(SimilarTicketSchema).optional(),
  reasoning: z.string().optional().describe('LLM reasoning for duplicate decision'),
});

// ============================================================================
// Worker Communication Schemas
// ============================================================================

/**
 * Triage status update from worker to backend
 */
export const TriageStatusUpdateSchema = z.object({
  ticketId: z.string().uuid(),
  status: TriageStatusSchema,
  sessionId: z.string().optional(),
  classification: ClassificationTypeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  intentSummary: z.string().optional(),
  relatedFiles: z.array(z.string()).optional(),
  isDuplicate: z.boolean().optional(),
  duplicateOfTicketId: z.string().uuid().optional(),
  similarityScore: z.number().min(0).max(1).optional(),
  actionTaken: ActionTakenSchema.optional(),
  actionMetadata: z.record(z.string(), z.unknown()).optional(),
  errorMessage: z.string().optional(),
});

/**
 * Dispatch triage request to worker
 */
export const DispatchTriageRequestSchema = z.object({
  ticketId: z.string().uuid(),
  authToken: z.string(),
  owner: OwnerSchema,
  sessionInput: z.object({
    repoFullName: z.string(),
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    issueBody: z.string().nullable(),
    duplicateThreshold: z.number().min(0).max(1),
    autoFixThreshold: z.number().min(0).max(1),
    customInstructions: z.string().nullable().optional(),
    modelSlug: z.string(),
    maxClassificationTimeMinutes: z.number().int().positive().min(1).max(15).optional(),
    // Deprecated fields (kept for backward compatibility)
    autoCreatePrThreshold: z.number().min(0).max(1).optional(),
    maxPRCreationTimeMinutes: z.number().int().positive().min(5).max(30).optional(),
  }),
});

// ============================================================================
// Inferred TypeScript Types from Zod Schemas
// ============================================================================

/**
 * Infer TypeScript types from Zod schemas for use in function signatures.
 * These provide type safety while keeping schemas as the single source of truth.
 */
export type TriageStatus = z.infer<typeof TriageStatusSchema>;
export type ClassificationType = z.infer<typeof ClassificationTypeSchema>;
export type ActionTaken = z.infer<typeof ActionTakenSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
export type AutoTriageAgentConfig = z.infer<typeof AutoTriageAgentConfigSchema>;
export type SaveAutoTriageConfig = z.infer<typeof SaveAutoTriageConfigSchema>;
export type CreateTicketParams = z.infer<typeof CreateTicketParamsSchema>;
export type UpdateTicketStatusParams = z.infer<typeof UpdateTicketStatusParamsSchema>;
export type ListTicketsParams = z.infer<typeof ListTicketsParamsSchema>;
export type ClassificationResult = z.infer<typeof ClassificationResultSchema>;
export type SimilarTicket = z.infer<typeof SimilarTicketSchema>;
export type DuplicateDetectionResult = z.infer<typeof DuplicateDetectionResultSchema>;
export type TriageStatusUpdate = z.infer<typeof TriageStatusUpdateSchema>;
export type DispatchTriageRequest = z.infer<typeof DispatchTriageRequestSchema>;

/**
 * Response type for list triage tickets
 */
export type ListTriageTicketsResponse = {
  tickets: AutoTriageTicket[];
  total: number;
  hasMore: boolean;
};
