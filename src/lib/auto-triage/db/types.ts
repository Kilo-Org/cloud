/**
 * Auto Triage - Database Types
 */

import type { AutoTriageTicket } from '@/db/schema';

/**
 * Owner type - discriminated union for org or user ownership
 */
export type Owner =
  | { type: 'org'; id: string; userId: string }
  | { type: 'user'; id: string; userId: string };

/**
 * Triage ticket status
 */
export type TriageStatus = 'pending' | 'analyzing' | 'actioned' | 'failed' | 'skipped';

/**
 * Triage ticket classification
 */
export type TriageClassification = 'bug' | 'feature' | 'question' | 'duplicate' | 'unclear';

/**
 * Action taken on a ticket
 */
export type TriageAction =
  | 'pr_created'
  | 'comment_posted'
  | 'closed_duplicate'
  | 'needs_clarification';

/**
 * Parameters for creating a new triage ticket
 */
export type CreateTicketParams = {
  owner: Owner;
  platformIntegrationId?: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  issueTitle: string;
  issueBody: string | null;
  issueAuthor: string;
  issueType: 'issue' | 'pull_request';
  issueLabels?: string[];
};

/**
 * Parameters for listing triage tickets
 */
export type ListTicketsParams = {
  owner: Owner;
  limit?: number;
  offset?: number;
  status?: TriageStatus;
  classification?: TriageClassification;
  repoFullName?: string;
};

/**
 * Parameters for updating a triage ticket
 */
export type UpdateTicketParams = {
  sessionId?: string;
  classification?: TriageClassification;
  confidence?: number;
  intentSummary?: string;
  relatedFiles?: string[];
  isDuplicate?: boolean;
  duplicateOfTicketId?: string;
  similarityScore?: number;
  qdrantPointId?: string;
  actionTaken?: TriageAction;
  actionMetadata?: Record<string, unknown>;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  shouldAutoFix?: boolean;
};

/**
 * Re-export AutoTriageTicket type from schema
 */
export type { AutoTriageTicket };
