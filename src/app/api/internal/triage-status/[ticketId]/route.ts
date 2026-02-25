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
import type { TriageStatus, TriageClassification, TriageAction } from '@/lib/auto-triage/db/types';

interface StatusUpdatePayload {
  sessionId?: string;
  status: TriageStatus;
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
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { ticketId } = await params;
    const payload: StatusUpdatePayload = await req.json();
    const { sessionId, status, errorMessage, ...updates } = payload;

    // Validate payload
    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

    logExceptInTest('[triage-status] Received status update', {
      ticketId,
      sessionId,
      status,
      hasError: !!errorMessage,
    });

    // Get current ticket to check if update is needed
    const ticket = await getTriageTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[triage-status] Ticket not found', { ticketId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Determine valid transitions based on incoming status
    const isTerminalState = ticket.status === 'actioned' || ticket.status === 'failed';

    if (isTerminalState) {
      // Already in terminal state - skip update
      logExceptInTest('[triage-status] Ticket already in terminal state, skipping update', {
        ticketId,
        currentStatus: ticket.status,
        requestedStatus: status,
      });
      return NextResponse.json({
        success: true,
        message: 'Ticket already in terminal state',
        currentStatus: ticket.status,
      });
    }

    // Valid transitions:
    // - pending -> analyzing (orchestrator starting)
    // - analyzing -> analyzing (sessionId update)
    // - analyzing -> actioned/failed (callback)
    // - pending -> actioned/failed (edge case: immediate failure)

    // Update ticket status in database
    await updateTriageTicketStatus(ticketId, status, {
      sessionId,
      errorMessage,
      startedAt: status === 'analyzing' ? new Date() : undefined,
      completedAt: status === 'actioned' || status === 'failed' ? new Date() : undefined,
      ...updates,
    });

    logExceptInTest('[triage-status] Updated ticket status', {
      ticketId,
      sessionId,
      status,
    });

    // Only trigger dispatch for terminal states (actioned/failed)
    // This frees up a slot for the next pending ticket
    if (status === 'actioned' || status === 'failed') {
      let owner;
      if (ticket.owned_by_organization_id) {
        const botUserId = await getBotUserId(ticket.owned_by_organization_id, 'auto-triage');
        if (botUserId) {
          owner = {
            type: 'org' as const,
            id: ticket.owned_by_organization_id,
            userId: botUserId,
          };
        } else {
          errorExceptInTest('[triage-status] Bot user not found for organization', {
            organizationId: ticket.owned_by_organization_id,
            ticketId,
          });
          captureMessage('Bot user missing for organization auto triage', {
            level: 'error',
            tags: { source: 'triage-status' },
            extra: { organizationId: ticket.owned_by_organization_id, ticketId },
          });
        }
      } else {
        owner = {
          type: 'user' as const,
          id: ticket.owned_by_user_id || '',
          userId: ticket.owned_by_user_id || '',
        };
      }

      if (owner) {
        // Trigger dispatch in background (don't await - fire and forget)
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
