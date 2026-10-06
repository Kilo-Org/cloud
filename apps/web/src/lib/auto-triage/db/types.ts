import type { AutoTriageTicket } from '@kilocode/db/schema';

export type Owner =
  | { type: 'org'; id: string; userId: string }
  | { type: 'user'; id: string; userId: string };

export type TriageStatus = 'pending' | 'analyzing' | 'actioned' | 'failed' | 'skipped';

export type TriageClassification = 'bug' | 'feature' | 'question' | 'duplicate' | 'unclear';

export type TriageAction =
  | 'pr_created'
  | 'comment_posted'
  | 'closed_duplicate'
  | 'needs_clarification';

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

export type ListTicketsParams = {
  owner: Owner;
  limit?: number;
  offset?: number;
  status?: TriageStatus;
  classification?: TriageClassification;
  repoFullName?: string;
};

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
};

export type { AutoTriageTicket };
