import * as z from 'zod';
import {
  CODE_REVIEW_PLATFORMS,
  ManualCodeReviewConfigSchema,
  CodeReviewTypeSchema,
  CodeReviewTriggerSourceSchema,
  CODE_REVIEW_TERMINAL_REASONS,
} from '@kilocode/db/schema-types';
import { CODE_REVIEW_STATUSES } from '@kilocode/app-shared/code-review';
import { CodeReviewAgentConfigSchema } from '@/lib/agent-config/core/types';
import { OwnerSchema, type Owner } from '@/lib/agent-config/core/owner';

export const CodeReviewStatusSchema = z.enum(CODE_REVIEW_STATUSES);

/**
 * Code review terminal reason enum, for narrowing a persisted
 * `cloud_agent_code_reviews.terminal_reason` back to the shared union.
 */
export const CodeReviewTerminalReasonSchema = z.enum(CODE_REVIEW_TERMINAL_REASONS);

const GitHubUserSchema = z.object({
  login: z.string(),
});

export const GitHubRepositorySchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
});

const GitHubRefSchema = z.object({
  ref: z.string(),
  sha: z.string(),
});

const GitHubPullRequestBaseSchema = GitHubRefSchema.extend({
  repo: GitHubRepositorySchema,
});

export const GitHubPullRequestSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.string().url(),
  title: z.string(),
  user: GitHubUserSchema,
  base: GitHubPullRequestBaseSchema,
  head: GitHubRefSchema,
});

export const CodeReviewWebhookPayloadSchema = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened']),
  pull_request: GitHubPullRequestSchema,
  repository: GitHubRepositorySchema,
  sender: GitHubUserSchema,
});

export const CodeReviewPlatformSchema = z.enum(CODE_REVIEW_PLATFORMS);
export type CodeReviewPlatform = z.infer<typeof CodeReviewPlatformSchema>;

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
  manualConfig: ManualCodeReviewConfigSchema.nullable().optional(),
  // Review type for this run; unset defaults to standard at the insert boundary.
  reviewType: CodeReviewTypeSchema.optional(),
  // Origin of the run (manual vs webhook); optional for legacy/unknown callers.
  triggerSource: CodeReviewTriggerSourceSchema.optional(),
});

export const UpdateReviewStatusParamsSchema = z.object({
  reviewId: z.string().uuid(),
  status: CodeReviewStatusSchema,
  sessionId: z.string().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.date().optional(),
  completedAt: z.date().optional(),
});

export const ListReviewsParamsSchema = z.object({
  owner: OwnerSchema,
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
  status: CodeReviewStatusSchema.optional(),
  repoFullName: z.string().optional(),
  platform: CodeReviewPlatformSchema.optional(),
});

export const ListCodeReviewsInputSchema = z.object({
  organizationId: z.string().uuid(),
  limit: z.number().int().min(1).max(100).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: CodeReviewStatusSchema.optional(),
  repoFullName: z.string().optional(),
  platform: CodeReviewPlatformSchema.optional(),
});

export const ListCodeReviewsForUserInputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50).optional(),
  offset: z.number().int().min(0).default(0).optional(),
  status: CodeReviewStatusSchema.optional(),
  repoFullName: z.string().optional(),
  platform: CodeReviewPlatformSchema.optional(),
});

export const GetCodeReviewInputSchema = z.object({
  reviewId: z.string().uuid(),
});

export const CancelCodeReviewInputSchema = z.object({
  reviewId: z.string().uuid(),
});

export const RetriggerCodeReviewInputSchema = z.object({
  reviewId: z.string().uuid(),
});

export const TriggerReviewParamsSchema = z.object({
  reviewId: z.string().uuid(),
  owner: OwnerSchema,
  agentConfig: z
    .object({
      config: CodeReviewAgentConfigSchema,
    })
    .passthrough(),
});

export type CodeReviewStatus = z.infer<typeof CodeReviewStatusSchema>;
export { OwnerSchema, type Owner };
export type CreateReviewParams = z.infer<typeof CreateReviewParamsSchema>;
export type UpdateReviewStatusParams = z.infer<typeof UpdateReviewStatusParamsSchema>;
export type ListReviewsParams = z.infer<typeof ListReviewsParamsSchema>;
export type TriggerReviewParams = z.infer<typeof TriggerReviewParamsSchema>;
