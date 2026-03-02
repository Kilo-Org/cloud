/**
 * Shared types for auto-fix worker
 */

import type { AutoFixOrchestrator } from './fix-orchestrator';
import type { Owner } from '@kilocode/worker-utils';

export type { Owner };

export type FixStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type FixClassification = 'bug' | 'feature' | 'question' | 'unclear';

export interface ClassificationResult {
  classification: FixClassification;
  confidence: number;
  intentSummary: string;
  relatedFiles?: string[];
  reasoning?: string;
  suggestedAction?: string;
}

export interface SessionInput {
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string | null;
  classification?: FixClassification;
  confidence?: number;
  intentSummary?: string;
  relatedFiles?: string[];
  githubToken?: string;
  kilocodeOrganizationId?: string;
  customInstructions?: string | null;
  modelSlug: string;
  prBaseBranch: string;
  prBranchPrefix: string;
  prTitleTemplate: string;
  prBodyTemplate?: string | null;
  maxPRCreationTimeMinutes?: number;
}

export interface FixEvent {
  timestamp: string;
  eventType: string;
  message?: string;
  content?: string;
  sessionId?: string;
}

export interface FixTicket {
  ticketId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  status: FixStatus;
  sessionId?: string;
  cliSessionId?: string;
  prNumber?: number;
  prUrl?: string;
  prBranch?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  events?: FixEvent[];
}

export interface FixStatusResponse {
  ticketId: string;
  status: FixStatus;
  sessionId?: string;
  cliSessionId?: string;
  prNumber?: number;
  prUrl?: string;
  prBranch?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface FixRequest {
  ticketId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
}

export interface FixResponse {
  ticketId: string;
  status: FixStatus;
}

/**
 * Environment bindings for the worker
 */
export interface Env {
  // Durable Object bindings
  AUTO_FIX_ORCHESTRATOR: DurableObjectNamespace<AutoFixOrchestrator>;

  // Environment variables
  API_URL: string;
  INTERNAL_API_SECRET: string;
  BACKEND_AUTH_TOKEN: string;
  CLOUD_AGENT_URL: string;
  CLOUD_AGENT_API_KEY: string;

  // Optional Sentry
  SENTRY_DSN?: string;
  CF_VERSION_METADATA?: {
    id: string;
  };
}
