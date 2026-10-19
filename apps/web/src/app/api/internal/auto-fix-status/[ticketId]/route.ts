/**
 * Internal API Endpoint: Auto Fix Status Updates
 *
 * Called by:
 * - Auto Fix Orchestrator (for 'running' status and sessionId updates)
 * - Cloud Agent callback (for 'completed' or 'failed' status)
 *
 * The ticketId is passed in the URL path.
 *
 * URL: POST /api/internal/auto-fix-status/{ticketId}
 * Protected by internal API secret
 */

import { authorizeInternalApiRequest } from '@/lib/internal-api-auth';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { updateFixTicketStatus, getFixTicketById } from '@/lib/auto-fix/db/fix-tickets';
import { tryDispatchPendingFixes } from '@/lib/auto-fix/dispatch/dispatch-pending-fixes';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { AutoFixStatusUpdateRequestSchema } from '@/lib/auto-fix/core/schemas';
import { formatAutoFixErrorMessage } from '@/lib/auto-fix/core/format-error-message';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ticketId: string }> }
) {
  try {
    // Validate internal API secret
    const unauthorized = authorizeInternalApiRequest(req);
    if (unauthorized) return unauthorized;

    const { ticketId } = await params;

    const raw: unknown = await req.json();
    const body = typeof raw === 'object' && raw !== null ? raw : {};
    const parsed = AutoFixStatusUpdateRequestSchema.safeParse({ ...body, ticketId });
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const { status, sessionId, cliSessionId, prNumber, prUrl, prBranch, errorMessage } =
      parsed.data;

    logExceptInTest('[auto-fix-status] Received status update', {
      ticketId,
      sessionId,
      cliSessionId,
      status,
      hasError: !!errorMessage,
      errorMessage,
    });

    // Get current ticket to check if update is needed
    const ticket = await getFixTicketById(ticketId);

    if (!ticket) {
      logExceptInTest('[auto-fix-status] Ticket not found', { ticketId });
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    // Determine valid transitions based on incoming status
    const isTerminalState =
      ticket.status === 'completed' || ticket.status === 'failed' || ticket.status === 'cancelled';

    if (isTerminalState) {
      // Already in terminal state - skip update
      logExceptInTest('[auto-fix-status] Ticket already in terminal state, skipping update', {
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
    // - pending -> running (orchestrator starting)
    // - running -> running (sessionId/cliSessionId update)
    // - running -> completed/failed (callback)
    // - pending -> completed/failed (edge case: immediate failure)

    // Update ticket status in database. Only the parsed request fields are
    // forwarded; startedAt/completedAt are always computed by
    // updateFixTicketStatus from the status transition.
    await updateFixTicketStatus(ticketId, status, {
      sessionId,
      cliSessionId,
      prNumber,
      prUrl,
      prBranch,
      errorMessage:
        errorMessage !== undefined ? formatAutoFixErrorMessage(errorMessage) : undefined,
    });

    logExceptInTest('[auto-fix-status] Updated ticket status', {
      ticketId,
      sessionId,
      cliSessionId,
      status,
    });

    // Only trigger dispatch for terminal states (completed/failed/cancelled)
    // This frees up a slot for the next pending fix
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      let owner;
      if (ticket.owned_by_organization_id) {
        const botUserId = await getBotUserId(ticket.owned_by_organization_id, 'auto-fix');
        if (botUserId) {
          owner = {
            type: 'org' as const,
            id: ticket.owned_by_organization_id,
            userId: botUserId,
          };
        } else {
          errorExceptInTest('[auto-fix-status] Bot user not found for organization', {
            organizationId: ticket.owned_by_organization_id,
            ticketId,
          });
          captureMessage('Bot user missing for organization auto fix', {
            level: 'error',
            tags: { source: 'auto-fix-status' },
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
        tryDispatchPendingFixes(owner).catch(dispatchError => {
          errorExceptInTest('[auto-fix-status] Error dispatching pending fixes:', dispatchError);
          captureException(dispatchError, {
            tags: { source: 'auto-fix-status-dispatch' },
            extra: { ticketId, owner },
          });
        });

        logExceptInTest('[auto-fix-status] Triggered dispatch for pending fixes', {
          ticketId,
          owner,
        });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[auto-fix-status] Error processing status update:', error);
    captureException(error, {
      tags: { source: 'auto-fix-status-api' },
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
