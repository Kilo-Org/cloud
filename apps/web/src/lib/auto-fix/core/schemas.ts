import * as z from 'zod';
import type { AutoFixTicket } from '@kilocode/db/schema';

export const AUTO_FIX_CONSTANTS = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  MAX_CONCURRENT_FIXES_PER_OWNER: 3,
  DEFAULT_MAX_PR_CREATION_TIME_MINUTES: 15,
  MIN_PR_CREATION_TIME_MINUTES: 5,
  MAX_PR_CREATION_TIME_MINUTES: 30,
} as const;

/**
 * Auto fix ticket status enum
 */
export const FixStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);

/**
 * Classification types for issues (subset from triage)
 */
export const FixClassificationTypeSchema = z.enum(['bug', 'feature', 'question', 'unclear']);

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

export const TriggerSourceSchema = z.enum(['label', 'review_comment']);

/**
 * Auto fix agent configuration schema
 * Used for storing configuration in agent_configs table
 */
export const AutoFixAgentConfigSchema = z
  .object({
    enabled_for_issues: z.boolean().describe('Enable auto fix for GitHub issues'),
    enabled_for_review_comments: z
      .boolean()
      .default(false)
      .describe('Enable auto fix for PR review comment @kilo mentions'),
    repository_selection_mode: z
      .enum(['all', 'selected'])
      .describe('Whether to fix all repositories or only selected ones'),
    selected_repository_ids: z
      .array(z.number().int().positive())
      .default([])
      .describe('List of repository IDs to enable auto fix for (when mode is "selected")'),
    skip_labels: z.array(z.string()).default([]).describe('Issue labels that should skip auto fix'),
    required_labels: z
      .array(z.string())
      .default([])
      .describe('Issue labels that must be present for auto fix to proceed'),
    model_slug: z
      .string()
      .default('anthropic/claude-sonnet-4.5')
      .describe('Model to use for PR creation'),
    custom_instructions: z
      .string()
      .nullable()
      .optional()
      .describe('Custom instructions for the fix agent'),
    pr_title_template: z
      .string()
      .default('Fix #{issue_number}: {issue_title}')
      .describe('Template for PR titles (supports {issue_number} and {issue_title})'),
    pr_body_template: z
      .string()
      .nullable()
      .optional()
      .describe('Optional template for PR descriptions'),
    pr_base_branch: z
      .string()
      .default('main')
      .describe('Base branch for PRs (e.g., main, master, develop)'),
    max_pr_creation_time_minutes: z
      .number()
      .int()
      .positive()
      .min(AUTO_FIX_CONSTANTS.MIN_PR_CREATION_TIME_MINUTES)
      .max(AUTO_FIX_CONSTANTS.MAX_PR_CREATION_TIME_MINUTES)
      .default(AUTO_FIX_CONSTANTS.DEFAULT_MAX_PR_CREATION_TIME_MINUTES)
      .describe('Maximum time for PR creation (5-30 minutes)'),
    max_concurrent_per_owner: z
      .number()
      .int()
      .positive()
      .default(AUTO_FIX_CONSTANTS.MAX_CONCURRENT_FIXES_PER_OWNER)
      .describe('Maximum concurrent fix operations per owner'),
  })
  .strict();

export const SaveAutoFixConfigSchema = z
  .object({
    organizationId: z.string().uuid(),
    enabled_for_issues: z.boolean(),
    enabled_for_review_comments: z.boolean().optional(),
    repository_selection_mode: z.enum(['all', 'selected']),
    selected_repository_ids: z.array(z.number().int().positive()).optional(),
    skip_labels: z.array(z.string()).optional(),
    required_labels: z.array(z.string()).optional(),
    model_slug: z.string().optional(),
    custom_instructions: z.string().nullable().optional(),
    pr_title_template: z.string().optional(),
    pr_body_template: z.string().nullable().optional(),
    pr_base_branch: z.string().optional(),
    max_pr_creation_time_minutes: z
      .number()
      .int()
      .positive()
      .min(AUTO_FIX_CONSTANTS.MIN_PR_CREATION_TIME_MINUTES)
      .max(AUTO_FIX_CONSTANTS.MAX_PR_CREATION_TIME_MINUTES)
      .optional(),
    max_concurrent_per_owner: z.number().int().positive().optional(),
  })
  .strict();

/**
 * GitHub label schema
 */
export const GitHubLabelSchema = z.object({
  name: z.string(),
  color: z.string().optional(),
});

export const IssueLabeledPayloadSchema = z.object({
  action: z.literal('labeled'),
  label: GitHubLabelSchema,
  issue: z.object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    title: z.string(),
    body: z.string().nullable(),
    user: z.object({
      login: z.string(),
    }),
    labels: z.array(
      z.union([
        z.string(),
        z.object({
          name: z.string(),
        }),
      ])
    ),
  }),
  repository: z.object({
    id: z.number().int(),
    full_name: z.string(),
  }),
});

export const CreateFixTicketParamsSchema = z.object({
  owner: OwnerSchema,
  platformIntegrationId: z.string().uuid().optional(),
  triageTicketId: z.string().uuid().optional(),
  repoFullName: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueUrl: z.string().url(),
  issueTitle: z.string().min(1),
  issueBody: z.string().nullable(),
  issueAuthor: z.string().min(1),
  issueLabels: z.array(z.string()).default([]),
  classification: FixClassificationTypeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  intentSummary: z.string().optional(),
  relatedFiles: z.array(z.string()).optional(),
  triggerSource: TriggerSourceSchema.optional(),
  reviewCommentId: z.number().int().positive().optional(),
  reviewCommentBody: z.string().optional(),
  filePath: z.string().optional(),
  lineNumber: z.number().int().positive().optional(),
  diffHunk: z.string().optional(),
  prHeadRef: z.string().optional(),
});

export const UpdateFixTicketStatusParamsSchema = z.object({
  ticketId: z.string().uuid(),
  status: FixStatusSchema,
  sessionId: z.string().optional(),
  cliSessionId: z.string().uuid().optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().optional(),
  prBranch: z.string().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
});

export const ListFixTicketsParamsSchema = z.object({
  owner: OwnerSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUTO_FIX_CONSTANTS.MAX_PAGE_SIZE)
    .default(AUTO_FIX_CONSTANTS.DEFAULT_PAGE_SIZE),
  offset: z.number().int().min(0).default(0),
  status: FixStatusSchema.optional(),
  classification: FixClassificationTypeSchema.optional(),
  repoFullName: z.string().optional(),
});

export const ListFixTicketsInputSchema = z.object({
  organizationId: z.string().uuid(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUTO_FIX_CONSTANTS.MAX_PAGE_SIZE)
    .default(AUTO_FIX_CONSTANTS.DEFAULT_PAGE_SIZE)
    .optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: FixStatusSchema.optional(),
  classification: FixClassificationTypeSchema.optional(),
  repoFullName: z.string().optional(),
});

export const ListFixTicketsForUserInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(AUTO_FIX_CONSTANTS.MAX_PAGE_SIZE)
    .default(AUTO_FIX_CONSTANTS.DEFAULT_PAGE_SIZE)
    .optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: FixStatusSchema.optional(),
  classification: FixClassificationTypeSchema.optional(),
  repoFullName: z.string().optional(),
});

export const GetFixTicketInputSchema = z.object({
  ticketId: z.string().uuid(),
});

export const RetriggerFixTicketInputSchema = z.object({
  ticketId: z.string().uuid(),
});

export const CancelFixTicketInputSchema = z.object({
  ticketId: z.string().uuid(),
});

export const GetAutoFixConfigInputSchema = z.object({
  organizationId: z.string().uuid(),
});

export const ToggleAutoFixAgentInputSchema = z.object({
  organizationId: z.string().uuid().optional(),
  isEnabled: z.boolean(),
});

/**
 * Fix status update from worker to backend
 */
export const FixStatusUpdateSchema = z.object({
  ticketId: z.string().uuid(),
  status: FixStatusSchema,
  sessionId: z.string().optional(),
  cliSessionId: z.string().uuid().optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().optional(),
  prBranch: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const DispatchFixRequestSchema = z.object({
  ticketId: z.string().uuid(),
  authToken: z.string(),
  owner: OwnerSchema,
  triggerSource: TriggerSourceSchema.optional(),
  sessionInput: z.object({
    repoFullName: z.string(),
    issueNumber: z.number().int().positive(),
    issueTitle: z.string(),
    issueBody: z.string().nullable(),
    classification: FixClassificationTypeSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    intentSummary: z.string().optional(),
    relatedFiles: z.array(z.string()).optional(),
    customInstructions: z.string().nullable().optional(),
    modelSlug: z.string(),
    maxPRCreationTimeMinutes: z
      .number()
      .int()
      .positive()
      .min(AUTO_FIX_CONSTANTS.MIN_PR_CREATION_TIME_MINUTES)
      .max(AUTO_FIX_CONSTANTS.MAX_PR_CREATION_TIME_MINUTES)
      .optional(),
    prTitleTemplate: z.string(),
    prBodyTemplate: z.string().nullable().optional(),
    prBaseBranch: z.string(),
    upstreamBranch: z.string().optional(),
    reviewCommentId: z.number().int().positive().optional(),
    reviewCommentBody: z.string().optional(),
    filePath: z.string().optional(),
    lineNumber: z.number().int().positive().optional(),
    diffHunk: z.string().optional(),
  }),
});

export type FixStatus = z.infer<typeof FixStatusSchema>;
export type FixClassificationType = z.infer<typeof FixClassificationTypeSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
export type AutoFixAgentConfig = z.infer<typeof AutoFixAgentConfigSchema>;
export type SaveAutoFixConfig = z.infer<typeof SaveAutoFixConfigSchema>;
export type CreateFixTicketParams = z.infer<typeof CreateFixTicketParamsSchema>;
export type UpdateFixTicketStatusParams = z.infer<typeof UpdateFixTicketStatusParamsSchema>;
export type ListFixTicketsParams = z.infer<typeof ListFixTicketsParamsSchema>;
export type FixStatusUpdate = z.infer<typeof FixStatusUpdateSchema>;
export type DispatchFixRequest = z.infer<typeof DispatchFixRequestSchema>;
export type IssueLabeledPayload = z.infer<typeof IssueLabeledPayloadSchema>;
export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

export type ListFixTicketsResponse = {
  tickets: AutoFixTicket[];
  total: number;
  hasMore: boolean;
};
