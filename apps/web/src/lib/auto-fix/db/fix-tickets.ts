import { db } from '@/lib/drizzle';
import { auto_fix_tickets } from '@kilocode/db/schema';
import { eq, and, desc, count, or } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { AUTO_FIX_CONSTANTS } from '../core/schemas';
import type {
  CreateFixTicketParams,
  ListFixTicketsParams,
  UpdateFixTicketStatusParams,
  Owner,
  FixStatus,
  FixClassificationType,
} from '../core/schemas';
import type { AutoFixTicket } from '@kilocode/db/schema';

export async function createFixTicket(params: CreateFixTicketParams): Promise<string> {
  try {
    const [ticket] = await db
      .insert(auto_fix_tickets)
      .values({
        owned_by_organization_id: params.owner.type === 'org' ? params.owner.id : null,
        owned_by_user_id: params.owner.type === 'user' ? params.owner.id : null,
        platform_integration_id: params.platformIntegrationId || null,
        triage_ticket_id: params.triageTicketId || null,
        repo_full_name: params.repoFullName,
        issue_number: params.issueNumber,
        issue_url: params.issueUrl,
        issue_title: params.issueTitle,
        issue_body: params.issueBody,
        issue_author: params.issueAuthor,
        issue_labels: params.issueLabels || [],
        trigger_source: params.triggerSource || 'label',
        review_comment_id: params.reviewCommentId || null,
        review_comment_body: params.reviewCommentBody || null,
        file_path: params.filePath || null,
        line_number: params.lineNumber || null,
        diff_hunk: params.diffHunk || null,
        pr_head_ref: params.prHeadRef || null,
        classification: params.classification || null,
        confidence: params.confidence?.toString() || null,
        intent_summary: params.intentSummary || null,
        related_files: params.relatedFiles || null,
        status: 'pending',
      })
      .returning({ id: auto_fix_tickets.id });

    return ticket.id;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createFixTicket' },
      extra: { params },
    });
    throw error;
  }
}

export async function getFixTicketById(ticketId: string): Promise<AutoFixTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_fix_tickets)
      .where(eq(auto_fix_tickets.id, ticketId))
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getFixTicketById' },
      extra: { ticketId },
    });
    throw error;
  }
}

export async function getFixTicketBySessionId(sessionId: string): Promise<AutoFixTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_fix_tickets)
      .where(eq(auto_fix_tickets.session_id, sessionId))
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getFixTicketBySessionId' },
      extra: { sessionId },
    });
    throw error;
  }
}

export async function findExistingFixTicket(
  repoFullName: string,
  issueNumber: number
): Promise<AutoFixTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_fix_tickets)
      .where(
        and(
          eq(auto_fix_tickets.repo_full_name, repoFullName),
          eq(auto_fix_tickets.issue_number, issueNumber),
          eq(auto_fix_tickets.trigger_source, 'label')
        )
      )
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findExistingFixTicket' },
      extra: { repoFullName, issueNumber },
    });
    throw error;
  }
}

/**
 * Checks if a fix ticket already exists for a given repo and review comment ID.
 * Returns tickets regardless of status so webhook deduplication stays aligned
 * with the unique index on (repo_full_name, review_comment_id).
 */
export async function findExistingReviewCommentFixTicket(
  repoFullName: string,
  reviewCommentId: number
): Promise<AutoFixTicket | null> {
  try {
    const [ticket] = await db
      .select()
      .from(auto_fix_tickets)
      .where(
        and(
          eq(auto_fix_tickets.repo_full_name, repoFullName),
          eq(auto_fix_tickets.review_comment_id, reviewCommentId)
        )
      )
      .limit(1);

    return ticket || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findExistingReviewCommentFixTicket' },
      extra: { repoFullName, reviewCommentId },
    });
    throw error;
  }
}

export async function updateFixTicketStatus(
  ticketId: string,
  status: FixStatus,
  updates: Partial<UpdateFixTicketStatusParams> = {}
): Promise<void> {
  try {
    const updateData: Partial<typeof auto_fix_tickets.$inferInsert> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (updates.sessionId !== undefined) {
      updateData.session_id = updates.sessionId;
    }
    if (updates.cliSessionId !== undefined) {
      updateData.cli_session_id = updates.cliSessionId;
    }
    if (updates.prNumber !== undefined) {
      updateData.pr_number = updates.prNumber;
    }
    if (updates.prUrl !== undefined) {
      updateData.pr_url = updates.prUrl;
    }
    if (updates.prBranch !== undefined) {
      updateData.pr_branch = updates.prBranch;
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

    if (status === 'running' && !updates.startedAt) {
      updateData.started_at = new Date().toISOString();
    }
    if (
      (status === 'completed' || status === 'failed' || status === 'cancelled') &&
      !updates.completedAt
    ) {
      updateData.completed_at = new Date().toISOString();
    }

    await db.update(auto_fix_tickets).set(updateData).where(eq(auto_fix_tickets.id, ticketId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateFixTicketStatus' },
      extra: { ticketId, status, updates },
    });
    throw error;
  }
}

export async function listFixTickets(params: ListFixTicketsParams): Promise<AutoFixTicket[]> {
  try {
    const {
      owner,
      limit = AUTO_FIX_CONSTANTS.DEFAULT_PAGE_SIZE,
      offset = 0,
      status,
      classification,
      repoFullName,
    } = params;

    const conditions = [];

    if (owner.type === 'org') {
      conditions.push(eq(auto_fix_tickets.owned_by_organization_id, owner.id));
    } else {
      conditions.push(eq(auto_fix_tickets.owned_by_user_id, owner.id));
    }

    if (status) {
      conditions.push(eq(auto_fix_tickets.status, status));
    }
    if (classification) {
      conditions.push(eq(auto_fix_tickets.classification, classification));
    }
    if (repoFullName) {
      conditions.push(eq(auto_fix_tickets.repo_full_name, repoFullName));
    }

    const tickets = await db
      .select()
      .from(auto_fix_tickets)
      .where(and(...conditions))
      .orderBy(desc(auto_fix_tickets.created_at))
      .limit(limit)
      .offset(offset);

    return tickets;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listFixTickets' },
      extra: { params },
    });
    throw error;
  }
}

export async function countFixTickets(params: {
  owner: Owner;
  status?: FixStatus;
  classification?: FixClassificationType;
  repoFullName?: string;
}): Promise<number> {
  try {
    const { owner, status, classification, repoFullName } = params;

    const conditions = [];

    if (owner.type === 'org') {
      conditions.push(eq(auto_fix_tickets.owned_by_organization_id, owner.id));
    } else {
      conditions.push(eq(auto_fix_tickets.owned_by_user_id, owner.id));
    }

    if (status) {
      conditions.push(eq(auto_fix_tickets.status, status));
    }
    if (classification) {
      conditions.push(eq(auto_fix_tickets.classification, classification));
    }
    if (repoFullName) {
      conditions.push(eq(auto_fix_tickets.repo_full_name, repoFullName));
    }

    const result = await db
      .select({ count: count() })
      .from(auto_fix_tickets)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'countFixTickets' },
      extra: { params },
    });
    throw error;
  }
}

export async function resetFixTicketForRetry(ticketId: string): Promise<void> {
  try {
    await db
      .update(auto_fix_tickets)
      .set({
        status: 'pending',
        session_id: null,
        cli_session_id: null,
        error_message: null,
        started_at: null,
        completed_at: null,
        updated_at: new Date().toISOString(),
      })
      .where(eq(auto_fix_tickets.id, ticketId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'resetFixTicketForRetry' },
      extra: { ticketId },
    });
    throw error;
  }
}

export async function cancelFixTicket(ticketId: string): Promise<void> {
  try {
    await db
      .update(auto_fix_tickets)
      .set({
        status: 'cancelled',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(eq(auto_fix_tickets.id, ticketId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cancelFixTicket' },
      extra: { ticketId },
    });
    throw error;
  }
}

export async function getActiveFixTicketsCount(owner: Owner): Promise<number> {
  try {
    const conditions = [
      owner.type === 'org'
        ? eq(auto_fix_tickets.owned_by_organization_id, owner.id)
        : eq(auto_fix_tickets.owned_by_user_id, owner.id),
      or(eq(auto_fix_tickets.status, 'running'), eq(auto_fix_tickets.status, 'pending')),
    ];

    const result = await db
      .select({ count: count() })
      .from(auto_fix_tickets)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getActiveFixTicketsCount' },
      extra: { owner },
    });
    throw error;
  }
}

export async function getPendingFixTickets(owner: Owner, limit: number): Promise<AutoFixTicket[]> {
  try {
    const ownerCondition =
      owner.type === 'org'
        ? eq(auto_fix_tickets.owned_by_organization_id, owner.id)
        : eq(auto_fix_tickets.owned_by_user_id, owner.id);

    const tickets = await db
      .select()
      .from(auto_fix_tickets)
      .where(and(ownerCondition, eq(auto_fix_tickets.status, 'pending')))
      .orderBy(auto_fix_tickets.created_at)
      .limit(limit);

    return tickets;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getPendingFixTickets' },
      extra: { owner, limit },
    });
    throw error;
  }
}
