/**
 * Internal API Endpoint: Auto Triage Status Updates
 *
 * Called by:
 * - Triage Orchestrator (for 'analyzing' status and sessionId updates)
 * - Cloud Agent callback (for 'actioned' or 'failed' status)
 *
 * The ticketId is passed in the URL path.
 *
 * URL: POST /api/internal/triage-status/{ticketId}
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { updateTriageTicketStatus, getTriageTicketById } from '@/lib/auto-triage/db/triage-tickets';
import { tryDispatchPendingTickets } from '@/lib/auto-triage/dispatch/dispatch-pending-tickets';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { z } from 'zod';
import type { TriageStatus, TriageClassification, TriageAction } from '@/lib/auto-triage/db/types';

const statusUpdatePayloadSchema = z.object({
  sessionId: z.string().optional(),
  status: z.enum(['pending', 'analyzing', 'actioned', 'failed', 'skipped']),
  classification: z.enum(['bug', 'feature', 'question', 'duplicate', 'unclear']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  intentSummary: z.string().optional(),
  relatedFiles: z.array(z.string()).optional(),
  isDuplicate: z.boolean().optional(),
  duplicateOfTicketId: z.string().uuid().optional(),
  similarityScore: z.number().min(0).max(1).optional(),
  qdrantPointId: z.string().optional(),
  actionTaken: z
    .enum(['pr_created', 'comment_posted', 'closed_duplicate', 'needs_clarification'])
    .optional(),
  actionMetadata: z.record(z.string(), z.unknown()).optional(),
  errorMessage: z.string().optional(),
  shouldAutoFix: z.boolean().optional(),
});

const ticketIdSchema = z.string().uuid();

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ticketId: rawTicketId } = await params;
    const ticketIdResult = ticketIdSchema.safeParse(rawTicketId);
    if (!ticketIdResult.success) {
      return NextResponse.json({ error: 'Invalid ticketId format' }, { status: 400 });
    }
    const ticketId = ticketIdResult.data;

    const parseResult = statusUpdatePayloadSchema.safeParse(await req.json());
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { sessionId, status, errorMessage, ...updates } = parseResult.data;

    logExceptInTest('[triage-status] Received status update', {
      ticketId,
      sessionId,
      status,
      hasError: !!errorMessage,
    });

    // Atomic update with terminal state guard in the WHERE clause.
    // Returns 0 if the ticket doesn't exist OR is already in a terminal state.
    const rowsUpdated = await updateTriageTicketStatus(ticketId, status, {
      sessionId,
      errorMessage,
      startedAt: status === 'analyzing' ? new Date() : undefined,
      completedAt: status === 'actioned' || status === 'failed' ? new Date() : undefined,
      ...updates,
    });

    if (rowsUpdated === 0) {
      const existing = await getTriageTicketById(ticketId);
      if (!existing) {
        logExceptInTest('[triage-status] Ticket not found', { ticketId });
        return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
      }
      logExceptInTest('[triage-status] Ticket already in terminal state, skipping update', {
        ticketId,
        currentStatus: existing.status,
        requestedStatus: status,
      });
      return NextResponse.json(
        {
          error: 'Ticket already in terminal state',
          currentStatus: existing.status,
        },
        { status: 409 }
      );
    }

    logExceptInTest('[triage-status] Updated ticket status', {
      ticketId,
      sessionId,
      status,
    });

    // Only trigger dispatch for terminal states (actioned/failed)
    // This frees up a slot for the next pending ticket
    if (status === 'actioned' || status === 'failed') {
      const ticket = await getTriageTicketById(ticketId);
      if (!ticket) {
        return NextResponse.json({ error: 'Ticket not found after update' }, { status: 500 });
      }

      let owner;
      if (ticket.owned_by_organization_id) {
        const botUserId = await getBotUserId(ticket.owned_by_organization_id, 'auto-triage');
        if (!botUserId) {
          errorExceptInTest('[triage-status] Bot user not found for organization', {
            organizationId: ticket.owned_by_organization_id,
            ticketId,
          });
          captureMessage('Bot user missing for organization auto triage', {
            level: 'error',
            tags: { source: 'triage-status' },
            extra: { organizationId: ticket.owned_by_organization_id, ticketId },
          });
          return NextResponse.json(
            { error: 'Bot user not found for organization' },
            { status: 500 }
          );
        }
        owner = {
          type: 'org' as const,
          id: ticket.owned_by_organization_id,
          userId: botUserId,
        };
      } else {
        owner = {
          type: 'user' as const,
          id: ticket.owned_by_user_id || '',
          userId: ticket.owned_by_user_id || '',
        };
      }

      tryDispatchPendingTickets(owner).catch(dispatchError => {
        errorExceptInTest('[triage-status] Error dispatching pending tickets:', dispatchError);
        captureException(dispatchError, {
          tags: { source: 'triage-status-dispatch' },
          extra: { ticketId, owner },
        });
      });

      logExceptInTest('[triage-status] Triggered dispatch for pending tickets', {
        ticketId,
        owner,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[triage-status] Error processing status update:', error);
    captureException(error, {
      tags: { source: 'triage-status-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process status update',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
