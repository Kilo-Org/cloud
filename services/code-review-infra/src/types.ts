/**
 * Shared types for code review worker
 */

import type { CodeReviewOrchestrator } from './code-review-orchestrator';
import type { Owner, MCPServerConfig, CloudAgentTerminalReason } from '@kilocode/worker-utils';
import type {
  ReviewAgentSelection,
  ReviewAgentsConfig,
} from '@kilocode/worker-utils/review-agents';
import * as z from 'zod';

export type { Owner, MCPServerConfig };
export type { ReviewAgentSelection, ReviewAgentsConfig };

export type CodeReviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SessionInput {
  /** GitHub repo in format "owner/repo" (for GitHub platform) */
  githubRepo?: string;
  /** Full git URL for cloning (for GitLab and other platforms) */
  gitUrl?: string;
  kilocodeOrganizationId?: string;
  prompt: string;
  mode: 'code';
  model: string;
  /** Thinking effort variant name (e.g. "high", "max") — undefined means model default */
  variant?: string;
  upstreamBranch: string;
  /** GitHub installation token (for GitHub platform) */
  githubToken?: string;
  /** Generic git token for authentication (for GitLab and other platforms) */
  gitToken?: string;
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab' | 'bitbucket';
  /** Managed Bitbucket workspace UUID. */
  bitbucketWorkspaceUuid?: string;
  /** Managed Bitbucket workspace slug. */
  bitbucketWorkspaceSlug?: string;
  /** Managed Bitbucket repository UUID. */
  bitbucketRepositoryUuid?: string;
  /** Managed Bitbucket repository slug. */
  bitbucketRepositorySlug?: string;
  /** Kilo Bitbucket platform integration ID. */
  bitbucketIntegrationId?: string;
  /** Bitbucket pull request ID. */
  bitbucketPullRequestId?: number;
  /** Head commit SHA that publication must remain fenced to. */
  bitbucketExpectedHeadSha?: string;
  envVars?: Record<string, string>;
  mcpServers?: Record<string, MCPServerConfig>;
  /** Gate threshold — when not 'off', the agent should report gateResult in its callback */
  gateThreshold?: 'off' | 'all' | 'warning' | 'critical';
}

export interface CodeReview {
  reviewId: string;
  attemptId?: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  status: CodeReviewStatus;
  sessionId?: string; // Cloud agent session ID (agent_xxx)
  cliSessionId?: string; // CLI session UUID (from session_created event or prepareSession)
  sandboxId?: string;
  errorMessage?: string;
  terminalReason?: CloudAgentTerminalReason;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  /** LLM model used (captured from first api_req_started event) */
  model?: string;
  /** Accumulated input tokens across all LLM calls */
  totalTokensIn?: number;
  /** Accumulated output tokens across all LLM calls */
  totalTokensOut?: number;
  /** Accumulated cost in dollars across all LLM calls */
  totalCost?: number;
  skipBalanceCheck?: boolean; // Skip balance validation in cloud agent (for OSS sponsorship)
  /** Cloud-agent session ID from a previous completed review, for session continuation */
  previousCloudAgentSessionId?: string;
  sandboxRetryAttempted?: boolean;
  /** Provider-reported repository storage size, formatted for log correlation. */
  repositorySize?: string | null;
  /** Forward-shaped review agent selections (only agents[0] consumed today). */
  reviewAgents?: ReviewAgentsConfig;
}

export interface CodeReviewStatusResponse {
  reviewId: string;
  attemptId?: string;
  status: CodeReviewStatus;
  sessionId?: string; // Cloud agent session ID (agent_xxx)
  cliSessionId?: string; // CLI session UUID
  startedAt?: string;
  completedAt?: string;
  /** LLM model used (captured from first api_req_started event) */
  model?: string;
  /** Accumulated input tokens across all LLM calls */
  totalTokensIn?: number;
  /** Accumulated output tokens across all LLM calls */
  totalTokensOut?: number;
  /** Accumulated cost in dollars across all LLM calls */
  totalCost?: number;
  errorMessage?: string;
  terminalReason?: CloudAgentTerminalReason;
}

export type CodeReviewStatusResult = CodeReviewStatusResponse | null;

const InternalStatusTerminalReasonSchema = z
  .enum([
    'billing',
    'model_not_found',
    'github_installation_required',
    'github_ip_allow_list',
    'gitlab_project_access_required',
    'byok_invalid_key',
    'selected_model_unavailable',
    'repeated_repository_clone_timeout',
    'user_cancelled',
    'superseded',
    'interrupted',
    'timeout',
    'upstream_error',
    'sandbox_error',
    'unknown',
  ])
  .nullable()
  .optional()
  .catch(undefined);

export const InternalStatusResponseSchema = z.object({
  success: z.boolean().optional(),
  message: z.string().optional(),
  currentStatus: z.enum(['completed', 'failed', 'cancelled']).optional(),
  terminalReason: InternalStatusTerminalReasonSchema,
  error: z.string().optional(),
});

export type InternalStatusResponse = z.infer<typeof InternalStatusResponseSchema>;

export interface CodeReviewRequest {
  reviewId: string;
  attemptId?: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  skipBalanceCheck?: boolean;
  /** Cloud-agent session ID from a previous completed review, for session continuation */
  previousCloudAgentSessionId?: string;
  /** Provider-reported repository storage size, formatted for log correlation. */
  repositorySize?: string | null;
  /** Forward-shaped review agent selections (only agents[0] consumed today). */
  reviewAgents?: ReviewAgentsConfig;
}

export interface CodeReviewResponse {
  reviewId: string;
  attemptId?: string;
  status: CodeReviewStatus;
}

/**
 * Environment bindings for the worker
 */
export interface Env {
  // Durable Object bindings
  CODE_REVIEW_ORCHESTRATOR: DurableObjectNamespace<CodeReviewOrchestrator>;

  // Environment variables
  API_URL: string;
  INTERNAL_API_SECRET: string;
  CALLBACK_TOKEN_SECRET: string;
  CLOUD_AGENT_NEXT_URL: string;
  BACKEND_AUTH_TOKEN: string;

  // Optional Sentry
  SENTRY_DSN?: string;
  CF_VERSION_METADATA?: {
    id: string;
  };
}
