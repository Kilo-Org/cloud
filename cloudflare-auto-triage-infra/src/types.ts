/**
 * Shared types for auto-triage worker
 */

import { z } from 'zod';
import type { TriageOrchestrator } from './triage-orchestrator';

export type TriageStatus = 'pending' | 'analyzing' | 'actioned' | 'failed' | 'skipped';

export type TriageClassification = 'bug' | 'feature' | 'question' | 'duplicate' | 'unclear';

export type TriageAction =
  | 'pr_created'
  | 'comment_posted'
  | 'closed_duplicate'
  | 'needs_clarification';

export type GitHubLabel = {
  name: string;
  color: string;
  description: string | null;
};

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
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string | null;
  githubToken?: string;
  kilocodeOrganizationId?: string;
  duplicateThreshold: number;
  autoFixThreshold: number;
  customInstructions?: string | null;
  modelSlug: string;
  baseBranch?: string;
  branchPrefix?: string;
  maxClassificationTimeMinutes?: number;
  autoCreatePrThreshold?: number;
  maxPRCreationTimeMinutes?: number;
}

export interface TriageEvent {
  timestamp: string;
  eventType: string;
  message?: string;
  content?: string; // Detailed content for expansion
  sessionId?: string;
}

export interface TriageTicket {
  ticketId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
  status: TriageStatus;
  sessionId?: string;
  classification?: TriageClassification;
  confidence?: number;
  intentSummary?: string;
  relatedFiles?: string[];
  isDuplicate?: boolean;
  duplicateOfTicketId?: string;
  similarityScore?: number;
  actionTaken?: TriageAction;
  actionMetadata?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  events?: TriageEvent[];
}

export interface TriageStatusResponse {
  ticketId: string;
  status: TriageStatus;
  sessionId?: string;
  classification?: TriageClassification;
  confidence?: number;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
}

export interface TriageRequest {
  ticketId: string;
  authToken: string;
  sessionInput: SessionInput;
  owner: Owner;
}

export interface TriageResponse {
  ticketId: string;
  status: TriageStatus;
}

export type SimilarTicket = {
  ticketId: string;
  issueNumber: number;
  issueTitle: string;
  similarity: number;
  repoFullName: string;
};

export interface DuplicateResult {
  isDuplicate: boolean;
  duplicateOfTicketId: string | null;
  similarityScore: number | null;
  reasoning?: string;
  similarTickets?: SimilarTicket[];
}

/**
 * Zod schemas for validation
 */
export const triageClassificationSchema = z.enum([
  'bug',
  'feature',
  'question',
  'duplicate',
  'unclear',
]);

export const classificationResultSchema = z.object({
  classification: triageClassificationSchema,
  confidence: z.number().min(0).max(1),
  intentSummary: z.string().min(1),
  relatedFiles: z.array(z.string()).optional(),
  reasoning: z.string().optional(),
  selectedLabels: z.array(z.string()).default([]),
});

export type ClassificationResult = z.infer<typeof classificationResultSchema>;

/**
 * Environment bindings for the worker
 */
export interface Env {
  // Durable Object bindings
  TRIAGE_ORCHESTRATOR: DurableObjectNamespace<TriageOrchestrator>;

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
