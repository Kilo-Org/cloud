/**
 * Shared types for code review worker
 */

import type { CodeReviewOrchestrator } from './code-review-orchestrator';
import type { Owner, MCPServerConfig } from '@kilocode/worker-utils';

export type { Owner, MCPServerConfig };

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
  upstreamBranch: string;
  /** GitHub installation token (for GitHub platform) */
  githubToken?: string;
  /** Generic git token for authentication (for GitLab and other platforms) */
  gitToken?: string;
  /** Git platform type for correct token/env var handling */
  platform?: 'github' | 'gitlab';
  envVars?: Record<string, string>;
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface CodeReviewEvent {
  timestamp: string;
  eventType: string;
  message?: string;
  content?: string; // Detailed content for expansion
  sessionId?: string;
}

export interface CodeReview {
  reviewId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  status: CodeReviewStatus;
  sessionId?: string; // Cloud agent session ID (agent_xxx)
  cliSessionId?: string; // CLI session UUID (from session_created event or prepareSession)
  errorMessage?: string;
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
  events?: CodeReviewEvent[];
  skipBalanceCheck?: boolean; // Skip balance validation in cloud agent (for OSS sponsorship)
  /** Which cloud agent backend to use: 'v1' (cloud-agent SSE) or 'v2' (cloud-agent-next) */
  agentVersion?: string;
}

export interface CodeReviewStatusResponse {
  reviewId: string;
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
}

export interface CodeReviewRequest {
  reviewId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  skipBalanceCheck?: boolean;
  /** Which cloud agent backend to use: 'v1' (cloud-agent SSE) or 'v2' (cloud-agent-next) */
  agentVersion?: string;
}

export interface CodeReviewResponse {
  reviewId: string;
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
  CLOUD_AGENT_URL: string;
  /** cloud-agent-next URL (used when useCloudAgentNext feature flag is enabled) */
  CLOUD_AGENT_NEXT_URL: string;
  BACKEND_AUTH_TOKEN: string;

  // Optional Sentry
  SENTRY_DSN?: string;
  CF_VERSION_METADATA?: {
    id: string;
  };
}
