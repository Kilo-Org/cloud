/**
 * Auto Triage - Database Operations
 *
 * Database operations for auto triage tickets.
 * Follows Drizzle ORM patterns used throughout the codebase.
 */

import { db } from '@/lib/drizzle';
import { auto_triage_tickets } from '@/db/schema';
import { eq, and, desc, count, or, notInArray } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';
import type {
  CreateTicketParams,
  ListTicketsParams,
  UpdateTicketParams,
  Owner,
  TriageStatus,
  TriageClassification,
  AutoTriageTicket,
} from './types';

/**
 * Creates a new triage ticket record
 * Returns the created ticket ID
 */
export async function createTriageTicket(params: CreateTicketParams): Promise<string> {
  try {
    const [ticket] = await db
      .insert(auto_triage_tickets)
      .values({
        owned_by_organization_id: params.owner.type === 'org' ? params.owner.id : null,
        owned_by_user_id: params.owner.type === 'user' ? params.owner.id : null,
        platform_integration_id: params.platformIntegrationId || null,
        repo_full_name: params.repoFullName,
        issue_number: params.issueNumber,
        issue_url: params.issueUrl,
        issue_title: params.issueTitle,
        issue_body: params.issueBody,
        issue_author: params.issueAuthor,
        issue_type: params.issueType,
        issue_labels: params.issueLabels || [],
        status: 'pending',
      })
      .returning({ id: auto_triage_tickets.id });

    return ticket.id;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createTriageTicket' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Gets a triage ticket by ID
 * Returns null if not found
 */
export async function getTriageTicketById(ticketId: string): Promise<AutoTriageTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_triage_tickets)
      .where(eq(auto_triage_tickets.id, ticketId))
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getTriageTicketById' },
      extra: { ticketId },
    });
    throw error;
  }
}

/**
 * Gets a triage ticket by session ID
 * Returns null if not found
 */
export async function getTriageTicketBySessionId(
  sessionId: string
): Promise<AutoTriageTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_triage_tickets)
      .where(eq(auto_triage_tickets.session_id, sessionId))
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getTriageTicketBySessionId' },
      extra: { sessionId },
    });
    throw error;
  }
}

/**
 * Checks if a triage ticket already exists for a given repo and issue number
 * Returns the existing ticket if found, null otherwise
 */
export async function findExistingTicket(
  repoFullName: string,
  issueNumber: number
): Promise<AutoTriageTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_triage_tickets)
      .where(
        and(
          eq(auto_triage_tickets.repo_full_name, repoFullName),
          eq(auto_triage_tickets.issue_number, issueNumber)
        )
      )
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findExistingTicket' },
      extra: { repoFullName, issueNumber },
    });
    throw error;
  }
}

/**
 * Gets a triage ticket by repo and issue number
 * Returns null if not found
 */
export async function getTriageTicketByRepoAndIssue(
  repoFullName: string,
  issueNumber: number
): Promise<AutoTriageTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_triage_tickets)
      .where(
        and(
          eq(auto_triage_tickets.repo_full_name, repoFullName),
          eq(auto_triage_tickets.issue_number, issueNumber)
        )
      )
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getTriageTicketByRepoAndIssue' },
      extra: { repoFullName, issueNumber },
    });
    throw error;
  }
}

/**
 * Updates triage ticket status and optional fields atomically.
 * The WHERE clause guards against overwriting terminal states ('actioned', 'failed').
 * Returns the number of rows updated (0 means the ticket was already terminal or doesn't exist).
 */
export async function updateTriageTicketStatus(
  ticketId: string,
  status: TriageStatus,
  updates: UpdateTicketParams = {}
): Promise<number> {
  try {
    const updateData: Partial<typeof auto_triage_tickets.$inferInsert> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (updates.sessionId !== undefined) {
      updateData.session_id = updates.sessionId;
    }
    if (updates.classification !== undefined) {
      updateData.classification = updates.classification;
    }
    if (updates.confidence !== undefined) {
      updateData.confidence = updates.confidence.toString();
    }
    if (updates.intentSummary !== undefined) {
      updateData.intent_summary = updates.intentSummary;
    }
    if (updates.relatedFiles !== undefined) {
      updateData.related_files = updates.relatedFiles;
    }
    if (updates.isDuplicate !== undefined) {
      updateData.is_duplicate = updates.isDuplicate;
    }
    if (updates.duplicateOfTicketId !== undefined) {
      updateData.duplicate_of_ticket_id = updates.duplicateOfTicketId;
    }
    if (updates.similarityScore !== undefined) {
      updateData.similarity_score = updates.similarityScore.toString();
    }
    if (updates.qdrantPointId !== undefined) {
      updateData.qdrant_point_id = updates.qdrantPointId;
    }
    if (updates.actionTaken !== undefined) {
      updateData.action_taken = updates.actionTaken;
    }
    if (updates.actionMetadata !== undefined) {
      updateData.action_metadata = updates.actionMetadata;
    }
    if (updates.errorMessage !== undefined) {
      updateData.error_message = updates.errorMessage;
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt.toISOString();
    }
    if (updates.completedAt !== undefined) {
      updateData.completed_at = updates.completedAt.toISOString();
    }
    if (updates.shouldAutoFix !== undefined) {
      updateData.should_auto_fix = updates.shouldAutoFix;
    }

    if (status === 'analyzing' && !updates.startedAt) {
      updateData.started_at = new Date().toISOString();
    }
    if (
      (status === 'actioned' || status === 'failed' || status === 'skipped') &&
      !updates.completedAt
    ) {
      updateData.completed_at = new Date().toISOString();
    }

    const result = await db
      .update(auto_triage_tickets)
      .set(updateData)
      .where(
        and(
          eq(auto_triage_tickets.id, ticketId),
          notInArray(auto_triage_tickets.status, ['actioned', 'failed'])
        )
      )
      .returning({ id: auto_triage_tickets.id });

    return result.length;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateTriageTicketStatus' },
      extra: { ticketId, status, updates },
    });
    throw error;
  }
}

/**
 * Lists triage tickets for an owner (org or user)
 * Supports filtering by status, classification, and repository
 * Returns tickets sorted by creation date (newest first)
 */
export async function listTriageTickets(params: ListTicketsParams): Promise<AutoTriageTicket[]> {
  try {
    const {
      owner,
      limit = AUTO_TRIAGE_CONSTANTS.DEFAULT_PAGE_SIZE,
      offset = 0,
      status,
      classification,
      repoFullName,
    } = params;

    // Build WHERE conditions
    const conditions = [];

    // Owner condition
    if (owner.type === 'org') {
      conditions.push(eq(auto_triage_tickets.owned_by_organization_id, owner.id));
    } else {
      conditions.push(eq(auto_triage_tickets.owned_by_user_id, owner.id));
    }

    // Optional filters
    if (status) {
      conditions.push(eq(auto_triage_tickets.status, status));
    }
    if (classification) {
      conditions.push(eq(auto_triage_tickets.classification, classification));
    }
    if (repoFullName) {
      conditions.push(eq(auto_triage_tickets.repo_full_name, repoFullName));
    }

    const tickets = await db
      .select()
      .from(auto_triage_tickets)
      .where(and(...conditions))
      .orderBy(desc(auto_triage_tickets.created_at))
      .limit(limit)
      .offset(offset);

    return tickets;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listTriageTickets' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Counts total triage tickets for an owner
 * Supports same filtering as listTriageTickets
 */
export async function countTriageTickets(params: {
  owner: Owner;
  status?: TriageStatus;
  classification?: TriageClassification;
  repoFullName?: string;
}): Promise<number> {
  try {
    const { owner, status, classification, repoFullName } = params;

    // Build WHERE conditions
    const conditions = [];

    // Owner condition
    if (owner.type === 'org') {
      conditions.push(eq(auto_triage_tickets.owned_by_organization_id, owner.id));
    } else {
      conditions.push(eq(auto_triage_tickets.owned_by_user_id, owner.id));
    }

    // Optional filters
    if (status) {
      conditions.push(eq(auto_triage_tickets.status, status));
    }
    if (classification) {
      conditions.push(eq(auto_triage_tickets.classification, classification));
    }
    if (repoFullName) {
      conditions.push(eq(auto_triage_tickets.repo_full_name, repoFullName));
    }

    const result = await db
      .select({ count: count() })
      .from(auto_triage_tickets)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'countTriageTickets' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Resets a failed triage ticket for retry
 * Clears status back to 'pending' and removes error/session data
 */
export async function resetTriageTicketForRetry(ticketId: string): Promise<void> {
  try {
    await db
      .update(auto_triage_tickets)
      .set({
        status: 'pending',
        session_id: null,
        error_message: null,
        started_at: null,
        completed_at: null,
        updated_at: new Date().toISOString(),
      })
      .where(eq(auto_triage_tickets.id, ticketId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'resetTriageTicketForRetry' },
      extra: { ticketId },
    });
    throw error;
  }
}

/**
 * Interrupts a pending or analyzing triage ticket.
 * Uses a status guard in the WHERE clause to avoid overwriting a ticket
 * that was concurrently completed by the orchestrator (TOCTOU protection).
 * Returns true if the ticket was actually interrupted, false if it had
 * already moved to a terminal state.
 */
export async function interruptTriageTicket(ticketId: string): Promise<boolean> {
  try {
    const result = await db
      .update(auto_triage_tickets)
      .set({
        status: 'failed',
        error_message: 'Manually interrupted by user',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(auto_triage_tickets.id, ticketId),
          or(eq(auto_triage_tickets.status, 'pending'), eq(auto_triage_tickets.status, 'analyzing'))
        )
      )
      .returning({ id: auto_triage_tickets.id });

    return result.length > 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'interruptTriageTicket' },
      extra: { ticketId },
    });
    throw error;
  }
}

/**
 * Gets count of active triage tickets for an owner (for concurrency control)
 * Active tickets are those with status 'analyzing'
 */
export async function getActiveTriageTicketsCount(owner: Owner): Promise<number> {
  try {
    const conditions = [
      owner.type === 'org'
        ? eq(auto_triage_tickets.owned_by_organization_id, owner.id)
        : eq(auto_triage_tickets.owned_by_user_id, owner.id),
      or(eq(auto_triage_tickets.status, 'analyzing'), eq(auto_triage_tickets.status, 'pending')),
    ];

    const result = await db
      .select({ count: count() })
      .from(auto_triage_tickets)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getActiveTriageTicketsCount' },
      extra: { owner },
    });
    throw error;
  }
}
