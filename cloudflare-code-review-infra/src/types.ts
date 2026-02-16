/**
 * Shared types for code review worker
 */

import type { CodeReviewOrchestrator } from './code-review-orchestrator';

export type CodeReviewStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Owner {
  type: 'user' | 'org';
  id: string;
  userId: string;
}

export interface MCPServerConfig {
  type: string;
  url: string;
  headers: Record<string, string>;
  timeout: number;
}

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
  cliSessionId?: string; // CLI session UUID (from session_created event)
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  events?: CodeReviewEvent[];
  skipBalanceCheck?: boolean; // Skip balance validation in cloud agent (for OSS sponsorship)
}

export interface CodeReviewStatusResponse {
  reviewId: string;
  status: CodeReviewStatus;
  sessionId?: string; // Cloud agent session ID (agent_xxx)
  cliSessionId?: string; // CLI session UUID (from session_created event)
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface CodeReviewRequest {
  reviewId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  skipBalanceCheck?: boolean;
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
  BACKEND_AUTH_TOKEN: string;

  // Optional Sentry
  SENTRY_DSN?: string;
  CF_VERSION_METADATA?: {
    id: string;
  };
}
