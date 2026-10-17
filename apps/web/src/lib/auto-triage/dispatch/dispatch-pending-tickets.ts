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
import { eq, and, count, notInArray, sql } from 'drizzle-orm';
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

interface TicketClaim {
  ticket: AutoTriageTicket | null;
  activeCount: number;
  remainingPending: number;
}

/**
 * Claim the next pending ticket for dispatch.
 *
 * The slot budget, the pending-row selection, and the pending -> 'analyzing'
 * transition happen inside one transaction serialized by a per-owner advisory
 * lock, so overlapping triggers for the same owner never observe the same
 * pending set. The status-conditional UPDATE only applies while the row is
 * still 'pending' and returns the claimed row; callers dispatch only what this
 * returns. One ticket is claimed per call so a pass never holds more than one
 * reservation at a time.
 */
async function claimNextPendingTicket(
  owner: Owner,
  excludedTicketIds: string[]
): Promise<TicketClaim> {
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

    const pendingCondition = and(
      ownerTicketCondition(owner),
      eq(auto_triage_tickets.status, 'pending')
    );

    const pendingCountResult = await tx
      .select({ count: count() })
      .from(auto_triage_tickets)
      .where(pendingCondition);
    const pendingCount = Number(pendingCountResult[0]?.count) || 0;

    logExceptInTest('[tryDispatchPendingTickets] Slot check', {
      owner,
      activeCount,
      availableSlots,
      pendingCount,
    });

    if (availableSlots <= 0) {
      return { ticket: null, activeCount, remainingPending: pendingCount };
    }

    const claimableCondition =
      excludedTicketIds.length > 0
        ? and(pendingCondition, notInArray(auto_triage_tickets.id, excludedTicketIds))
        : pendingCondition;

    const [candidate] = await tx
      .select()
      .from(auto_triage_tickets)
      .where(claimableCondition)
      .orderBy(auto_triage_tickets.created_at)
      .limit(1);

    if (!candidate) {
      return { ticket: null, activeCount, remainingPending: pendingCount };
    }

    const [claimed] = await tx
      .update(auto_triage_tickets)
      .set({
        status: 'analyzing',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .where(
        and(eq(auto_triage_tickets.id, candidate.id), eq(auto_triage_tickets.status, 'pending'))
      )
      .returning();

    if (!claimed) {
      return { ticket: null, activeCount, remainingPending: pendingCount };
    }

    return {
      ticket: claimed,
      activeCount: activeCount + 1,
      remainingPending: pendingCount - 1,
    };
  });
}

/**
 * Try to dispatch pending tickets for an owner
 * Checks available slots and dispatches up to available capacity
 */
export async function tryDispatchPendingTickets(owner: Owner): Promise<DispatchResult> {
  try {
    logExceptInTest(`[tryDispatchPendingTickets] Starting dispatch check`, {
      owner,
    });

    let dispatched = 0;
    let pending = 0;
    let activeCount = 0;
    const failedTicketIds: string[] = [];

    // Claim and dispatch one ticket per iteration. Each claim re-reads the
    // owner's active count under the advisory lock, so the concurrency ceiling
    // holds across overlapping passes, while only the ticket about to be
    // dispatched is ever reserved.
    for (;;) {
      const claim = await claimNextPendingTicket(owner, failedTicketIds);
      pending = claim.remainingPending;
      activeCount = claim.activeCount;

      if (!claim.ticket) {
        break;
      }

      const ticket = claim.ticket;
      try {
        await dispatchTicket(ticket, owner);
        dispatched++;
      } catch (error) {
        failedTicketIds.push(ticket.id);
        errorExceptInTest('[tryDispatchPendingTickets] Failed to dispatch ticket', {
          ticketId: ticket.id,
          error,
        });
        captureException(error, {
          tags: { operation: 'dispatch-pending-ticket' },
          extra: { ticketId: ticket.id, owner },
        });
        // Return the ticket to 'pending' so a later pass can retry it. The
        // failure is logged and captured; no error message is persisted, so a
        // recovered ticket does not keep rendering a stale dispatch error.
        try {
          await updateTriageTicketStatus(ticket.id, 'pending', {
            expectedStatus: 'analyzing',
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
      pending,
    });

    return { dispatched, pending, activeCount };
  } catch (error) {
    errorExceptInTest('[tryDispatchPendingTickets] Error during dispatch', {
      owner,
      error,
    });
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
