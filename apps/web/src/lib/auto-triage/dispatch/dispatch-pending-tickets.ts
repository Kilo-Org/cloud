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

import { db } from '@kilocode/web-shared/lib/drizzle';
import { auto_triage_tickets, type AutoTriageTicket } from '@kilocode/db/schema';
import { eq, and, count, inArray, sql } from 'drizzle-orm';
import type { Owner } from '../core';
import { prepareTriagePayload } from '../triggers/prepare-triage-payload';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { updateTriageTicketStatus } from '../db/triage-tickets';
import { captureException } from '@sentry/nextjs';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { triageWorkerClient } from '../client/triage-worker-client';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';

export interface DispatchResult {
  dispatched: number;
  pending: number;
  activeCount: number;
}

function ownerTicketCondition(owner: Owner) {
  return owner.type === 'org'
    ? eq(auto_triage_tickets.owned_by_organization_id, owner.id)
    : eq(auto_triage_tickets.owned_by_user_id, owner.id);
}

interface TicketReservation {
  activeCount: number;
  reserved: AutoTriageTicket[];
  remainingPending: number;
}

/**
 * Reserve pending tickets for dispatch.
 *
 * The pending -> 'analyzing' transition and the concurrency-slot budget are
 * decided inside one transaction serialized by a per-owner advisory lock, so
 * overlapping triggers for the same owner process disjoint sets. Each ticket
 * is claimed with a status-conditional UPDATE that moves it only while it is
 * still 'pending' and returns the claimed rows.
 */
async function reservePendingTicketsForDispatch(owner: Owner): Promise<TicketReservation> {
  return await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('auto-triage-dispatch'), hashtext(${`${owner.type}:${owner.id}`}))`
    );

    const activeCountResult = await tx
      .select({ count: count() })
      .from(auto_triage_tickets)
      .where(and(ownerTicketCondition(owner), eq(auto_triage_tickets.status, 'analyzing')));

    const activeCount = Number(activeCountResult[0]?.count) || 0;
    const availableSlots = AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER - activeCount;

    logExceptInTest('[tryDispatchPendingTickets] Active count check', {
      owner,
      activeCount,
      availableSlots,
    });

    const pendingCondition = and(
      ownerTicketCondition(owner),
      eq(auto_triage_tickets.status, 'pending')
    );

    if (availableSlots <= 0) {
      const remaining = await tx
        .select({ count: count() })
        .from(auto_triage_tickets)
        .where(pendingCondition);
      return { activeCount, reserved: [], remainingPending: Number(remaining[0]?.count) || 0 };
    }

    // Fetch one extra to check if there are more pending beyond max concurrent
    const candidates = await tx
      .select()
      .from(auto_triage_tickets)
      .where(pendingCondition)
      .orderBy(auto_triage_tickets.created_at)
      .limit(AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER + 1);

    const remainingPendingExtra = Math.max(candidates.length - availableSlots, 0);

    if (candidates.length === 0) {
      return { activeCount, reserved: [], remainingPending: 0 };
    }

    const slice = candidates.slice(0, availableSlots);
    const reserved = await tx
      .update(auto_triage_tickets)
      .set({
        status: 'analyzing',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          inArray(
            auto_triage_tickets.id,
            slice.map(ticket => ticket.id)
          ),
          eq(auto_triage_tickets.status, 'pending')
        )
      )
      .returning();

    return { activeCount, reserved, remainingPending: remainingPendingExtra };
  });
}

/**
 * Try to dispatch pending tickets for an owner
 * Checks available slots and dispatches up to available capacity
 */
export async function tryDispatchPendingTickets(owner: Owner): Promise<DispatchResult> {
  try {
    logExceptInTest(`[tryDispatchPendingTickets] Starting dispatch check`, { owner });

    const { activeCount, reserved, remainingPending } =
      await reservePendingTicketsForDispatch(owner);

    logExceptInTest('[tryDispatchPendingTickets] Reserved pending tickets', {
      owner,
      reservedCount: reserved.length,
    });

    // If no tickets reserved, return early
    if (reserved.length === 0) {
      logExceptInTest('[tryDispatchPendingTickets] No slots available', { owner, activeCount });
      return { dispatched: 0, pending: remainingPending, activeCount };
    }

    let dispatched = 0;
    const failed: string[] = [];
    for (const ticket of reserved) {
      try {
        await dispatchTicket(ticket, owner);
        dispatched++;
      } catch (error) {
        failed.push(ticket.id);
        errorExceptInTest('[tryDispatchPendingTickets] Failed to dispatch ticket', {
          ticketId: ticket.id,
          error,
        });
        captureException(error, {
          tags: { operation: 'dispatch-pending-ticket' },
          extra: { ticketId: ticket.id, owner },
        });
        // Return the ticket to 'pending' so a later pass can retry it
        try {
          await updateTriageTicketStatus(ticket.id, 'pending', {
            expectedStatus: 'analyzing',
            errorMessage: 'Dispatch failed',
            startedAt: null,
          });
        } catch (resetError) {
          errorExceptInTest(
            '[tryDispatchPendingTickets] Failed to reset ticket after dispatch error',
            {
              ticketId: ticket.id,
              error: resetError,
            }
          );
        }
      }
    }

    logExceptInTest('[tryDispatchPendingTickets] Dispatch complete', {
      owner,
      dispatched,
      total: reserved.length,
    });

    return {
      dispatched,
      pending: remainingPending + failed.length,
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

  // 3. Dispatch to Cloudflare Worker to create TriageOrchestrator DO
  // The status was already set to 'analyzing' when the ticket was reserved.
  await triageWorkerClient.dispatchTriage(payload);

  logExceptInTest('[dispatchTicket] Ticket dispatched successfully', {
    ticketId: ticket.id,
  });
}
