/**
 * Code Reviews - Zod Validation Schemas
 *
 * Runtime validation schemas for code review inputs.
 * Follows validation patterns used throughout the codebase.
 */

import * as z from 'zod';
import type { CloudAgentCodeReview } from '@/db/schema';
import { CodeReviewAgentConfigSchema } from '@/lib/agent-config/core/types';

// ============================================================================
// Status and Ownership Schemas
// ============================================================================

/**
 * Code review status enum
 */
export const CodeReviewStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
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
// GitHub Webhook Schemas
// ============================================================================

/**
 * GitHub user schema
 */
const GitHubUserSchema = z.object({
  login: z.string(),
});

/**
 * GitHub repository schema
 */
export const GitHubRepositorySchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
});

/**
 * GitHub pull request base/head ref schema
 */
const GitHubRefSchema = z.object({
  ref: z.string(),
  sha: z.string(),
});

/**
 * GitHub pull request base schema (includes repo)
 */
const GitHubPullRequestBaseSchema = GitHubRefSchema.extend({
  repo: GitHubRepositorySchema,
});

/**
 * GitHub pull request schema
 */
export const GitHubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  title: z.string(),
  user: GitHubUserSchema,
  base: GitHubPullRequestBaseSchema,
  head: GitHubRefSchema,
});

/**
 * GitHub pull_request webhook payload
 * Actions: opened, synchronize, reopened
 */
export const CodeReviewWebhookPayloadSchema = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened']),
  pull_request: GitHubPullRequestSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubUserSchema,
});

// ============================================================================
// Database Operation Schemas
// ============================================================================

/**
 * Platform type for code reviews
 */
export const CodeReviewPlatformSchema = z.enum(['github', 'gitlab']);
export type CodeReviewPlatform = z.infer<typeof CodeReviewPlatformSchema>;

/**
 * Create review params schema
 */
export const CreateReviewParamsSchema = z.object({
  owner: OwnerSchema,
  platformIntegrationId: z.string().uuid().optional(),
  repoFullName: z.string().min(1),
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
  prTitle: z.string().min(1),
  prAuthor: z.string().min(1),
  prAuthorGithubId: z.string().optional(),
  baseRef: z.string().min(1),
  headRef: z.string().min(1),
  headSha: z.string().min(1),
  platform: CodeReviewPlatformSchema.default('github'),
  platformProjectId: z.number().int().positive().optional(),
});

/**
 * Update review status params schema
 */
export const UpdateReviewStatusParamsSchema = z.object({
  reviewId: z.string().uuid(),
  status: CodeReviewStatusSchema,
  sessionId: z.string().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
});

/**
 * List reviews params schema
 */
export const ListReviewsParamsSchema = z.object({
  owner: OwnerSchema,
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  status: CodeReviewStatusSchema.optional(),
  repoFullName: z.string().optional(),
  platform: CodeReviewPlatformSchema.optional(),
});

// ============================================================================
// tRPC Input Schemas
// ============================================================================

/**
 * List code reviews input (for organizations)
 */
export const ListCodeReviewsInputSchema = z.object({
  organizationId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: CodeReviewStatusSchema.optional(),
  repoFullName: z.string().optional(),
  platform: CodeReviewPlatformSchema.optional(),
});

/**
 * List code reviews input (for personal users)
 */
export const ListCodeReviewsForUserInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: CodeReviewStatusSchema.optional(),
  repoFullName: z.string().optional(),
  platform: CodeReviewPlatformSchema.optional(),
});

/**
 * Get code review input
 */
export const GetCodeReviewInputSchema = z.object({
  reviewId: z.string().uuid(),
});

/**
 * Cancel code review input
 */
export const CancelCodeReviewInputSchema = z.object({
  reviewId: z.string().uuid(),
});

/**
 * Retrigger code review input
 */
export const RetriggerCodeReviewInputSchema = z.object({
  reviewId: z.string().uuid(),
});

// ============================================================================
// Trigger Schemas
// ============================================================================

/**
 * Trigger review params schema
 */
export const TriggerReviewParamsSchema = z.object({
  reviewId: z.string().uuid(),
  owner: OwnerSchema,
  agentConfig: z
    .object({
      config: CodeReviewAgentConfigSchema,
    })
    .passthrough(), // Allow additional fields beyond config
});

// ============================================================================
// Inferred TypeScript Types from Zod Schemas
// ============================================================================

/**
 * Infer TypeScript types from Zod schemas for use in function signatures.
 * These provide type safety while keeping schemas as the single source of truth.
 */
export type CodeReviewStatus = z.infer<typeof CodeReviewStatusSchema>;
export type Owner = z.infer<typeof OwnerSchema>;
export type CreateReviewParams = z.infer<typeof CreateReviewParamsSchema>;
export type UpdateReviewStatusParams = z.infer<typeof UpdateReviewStatusParamsSchema>;
export type ListReviewsParams = z.infer<typeof ListReviewsParamsSchema>;
export type TriggerReviewParams = z.infer<typeof TriggerReviewParamsSchema>;

/**
 * Response type for list code reviews
 */
export type ListCodeReviewsResponse = {
  reviews: CloudAgentCodeReview[];
  total: number;
  hasMore: boolean;
};
