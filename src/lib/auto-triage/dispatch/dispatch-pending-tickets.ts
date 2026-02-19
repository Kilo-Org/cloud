/**
 * Dispatch Pending Triage Tickets
 *
 * Core dispatch logic for auto triage. Checks available slots and dispatches
 * pending tickets to Cloudflare Worker.
 *
 * Triggered by:
 * 1. Webhook handler after creating new pending ticket
 * 2. Ticket completion (status update API) to dispatch next in queue
 */

import { db } from '@/lib/drizzle';
import { auto_triage_tickets, type AutoTriageTicket } from '@/db/schema';
import { eq, and, count } from 'drizzle-orm';
import type { Owner } from '../core';
import { prepareTriagePayload } from '../triggers/prepare-triage-payload';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { updateTriageTicketStatus } from '../db/triage-tickets';
import { captureException } from '@sentry/nextjs';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import { getTriageWorkerClient } from '../client/triage-worker-client';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';

export interface DispatchResult {
  dispatched: number;
  pending: number;
  activeCount: number;
}

/**
 * Try to dispatch pending tickets for an owner
 * Checks available slots and dispatches up to available capacity
 */
export async function tryDispatchPendingTickets(owner: Owner): Promise<DispatchResult> {
  try {
    logExceptInTest(`[tryDispatchPendingTickets] Starting dispatch check`, { owner });

    // 1. Get pending tickets for this owner (FIFO)
    // Fetch one extra to check if there are more pending beyond max concurrent
    const pendingTickets = await db
      .select()
      .from(auto_triage_tickets)
      .where(
        and(
          owner.type === 'org'
            ? eq(auto_triage_tickets.owned_by_organization_id, owner.id)
            : eq(auto_triage_tickets.owned_by_user_id, owner.id),
          eq(auto_triage_tickets.status, 'pending')
        )
      )
      .orderBy(auto_triage_tickets.created_at)
      .limit(AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER + 1);

    logExceptInTest('[tryDispatchPendingTickets] Found pending tickets', {
      owner,
      pendingCount: pendingTickets.length,
    });

    // 2. If no pending tickets, return early without querying active count
    if (pendingTickets.length === 0) {
      return { dispatched: 0, pending: 0, activeCount: 0 };
    }

    // 3. Only query active count if we have pending tickets to potentially dispatch
    const activeCountResult = await db
      .select({ count: count() })
      .from(auto_triage_tickets)
      .where(
        and(
          owner.type === 'org'
            ? eq(auto_triage_tickets.owned_by_organization_id, owner.id)
            : eq(auto_triage_tickets.owned_by_user_id, owner.id),
          eq(auto_triage_tickets.status, 'analyzing')
        )
      );

    const activeCount = activeCountResult[0]?.count || 0;
    const availableSlots = AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER - activeCount;

    logExceptInTest('[tryDispatchPendingTickets] Active count check', {
      owner,
      activeCount,
      availableSlots,
    });

    // 4. If no slots available, return early
    if (availableSlots <= 0) {
      logExceptInTest('[tryDispatchPendingTickets] No slots available', { owner, activeCount });
      return { dispatched: 0, pending: pendingTickets.length, activeCount };
    }

    // 5. Limit pending tickets to available slots and dispatch them
    const ticketsToDispatch = pendingTickets.slice(0, availableSlots);
    let dispatched = 0;
    for (const ticket of ticketsToDispatch) {
      try {
        await dispatchTicket(ticket, owner);
        dispatched++;
      } catch (error) {
        errorExceptInTest('[tryDispatchPendingTickets] Failed to dispatch ticket', {
          ticketId: ticket.id,
          error,
        });
        captureException(error, {
          tags: { operation: 'dispatch-pending-ticket' },
          extra: { ticketId: ticket.id, owner },
        });
      }
    }

    logExceptInTest('[tryDispatchPendingTickets] Dispatch complete', {
      owner,
      dispatched,
      total: ticketsToDispatch.length,
    });

    return {
      dispatched,
      pending: ticketsToDispatch.length - dispatched,
      activeCount: activeCount + dispatched,
    };
  } catch (error) {
    errorExceptInTest('[tryDispatchPendingTickets] Error during dispatch', { owner, error });
    captureException(error, {
      tags: { operation: 'try-dispatch-pending-tickets' },
      extra: { owner },
    });
    return { dispatched: 0, pending: 0, activeCount: 0 };
  }
}

/**
 * Dispatch a single ticket to Cloudflare Worker
 */
async function dispatchTicket(ticket: AutoTriageTicket, owner: Owner): Promise<void> {
  logExceptInTest('[dispatchTicket] Dispatching ticket', {
    ticketId: ticket.id,
    owner,
  });

  // 1. Get agent config for owner
  const agentConfig = await getAgentConfigForOwner(owner, 'auto_triage', 'github');

  if (!agentConfig) {
    throw new Error(`Agent config not found for owner ${owner.type}:${owner.id}`);
  }

  // 2. Prepare complete payload for cloud agent
  const payload = await prepareTriagePayload({
    ticketId: ticket.id,
    owner,
    agentConfig,
  });

  // 3. Update status to "analyzing" (no longer pending)
  await updateTriageTicketStatus(ticket.id, 'analyzing');

  // 4. Dispatch to Cloudflare Worker to create TriageOrchestrator DO
  await getTriageWorkerClient().dispatchTriage(payload);

  logExceptInTest('[dispatchTicket] Ticket dispatched successfully', {
    ticketId: ticket.id,
  });
}
