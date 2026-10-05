import { db } from '@/lib/drizzle';
import { auto_fix_tickets, type AutoFixTicket } from '@kilocode/db/schema';
import { eq, and, count } from 'drizzle-orm';
import type { Owner } from '../core/schemas';
import { prepareFixPayload } from '../triggers/prepare-fix-payload';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { updateFixTicketStatus } from '../db/fix-tickets';
import { captureException } from '@sentry/nextjs';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import { autoFixWorkerClient } from '../client/auto-fix-worker-client';
import { AUTO_FIX_CONSTANTS } from '../core/schemas';

export interface DispatchResult {
  dispatched: number;
  pending: number;
  activeCount: number;
}

export async function tryDispatchPendingFixes(owner: Owner): Promise<DispatchResult> {
  try {
    logExceptInTest(`[tryDispatchPendingFixes] Starting dispatch check`, { owner });

    const pendingTickets = await db
      .select()
      .from(auto_fix_tickets)
      .where(
        and(
          owner.type === 'org'
            ? eq(auto_fix_tickets.owned_by_organization_id, owner.id)
            : eq(auto_fix_tickets.owned_by_user_id, owner.id),
          eq(auto_fix_tickets.status, 'pending')
        )
      )
      .orderBy(auto_fix_tickets.created_at)
      .limit(AUTO_FIX_CONSTANTS.MAX_CONCURRENT_FIXES_PER_OWNER + 1);

    logExceptInTest('[tryDispatchPendingFixes] Found pending tickets', {
      owner,
      pendingCount: pendingTickets.length,
    });

    if (pendingTickets.length === 0) {
      return { dispatched: 0, pending: 0, activeCount: 0 };
    }

    const activeCountResult = await db
      .select({ count: count() })
      .from(auto_fix_tickets)
      .where(
        and(
          owner.type === 'org'
            ? eq(auto_fix_tickets.owned_by_organization_id, owner.id)
            : eq(auto_fix_tickets.owned_by_user_id, owner.id),
          eq(auto_fix_tickets.status, 'running')
        )
      );

    const activeCount = activeCountResult[0]?.count || 0;
    const availableSlots = AUTO_FIX_CONSTANTS.MAX_CONCURRENT_FIXES_PER_OWNER - activeCount;

    logExceptInTest('[tryDispatchPendingFixes] Active count check', {
      owner,
      activeCount,
      availableSlots,
    });

    if (availableSlots <= 0) {
      logExceptInTest('[tryDispatchPendingFixes] No slots available', { owner, activeCount });
      return { dispatched: 0, pending: pendingTickets.length, activeCount };
    }

    const ticketsToDispatch = pendingTickets.slice(0, availableSlots);
    let dispatched = 0;
    for (const ticket of ticketsToDispatch) {
      try {
        await dispatchFixTicket(ticket, owner);
        dispatched++;
      } catch (error) {
        errorExceptInTest('[tryDispatchPendingFixes] Failed to dispatch ticket', {
          ticketId: ticket.id,
          error,
        });
        captureException(error, {
          tags: { operation: 'dispatch-pending-fix-ticket' },
          extra: { ticketId: ticket.id, owner },
        });
      }
    }

    logExceptInTest('[tryDispatchPendingFixes] Dispatch complete', {
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
    errorExceptInTest('[tryDispatchPendingFixes] Error during dispatch', { owner, error });
    captureException(error, {
      tags: { operation: 'try-dispatch-pending-fixes' },
      extra: { owner },
    });
    return { dispatched: 0, pending: 0, activeCount: 0 };
  }
}

/**
 * Dispatch a single fix ticket to Cloudflare Worker
 */
async function dispatchFixTicket(ticket: AutoFixTicket, owner: Owner): Promise<void> {
  logExceptInTest('[dispatchFixTicket] Dispatching ticket', {
    ticketId: ticket.id,
    owner,
  });

  const agentConfig = await getAgentConfigForOwner(owner, 'auto_fix', 'github');

  if (!agentConfig) {
    throw new Error(`Agent config not found for owner ${owner.type}:${owner.id}`);
  }

  const payload = await prepareFixPayload({
    ticketId: ticket.id,
    owner,
    agentConfig,
  });

  await updateFixTicketStatus(ticket.id, 'running');

  await autoFixWorkerClient.dispatchFix(payload);

  logExceptInTest('[dispatchFixTicket] Ticket dispatched successfully', {
    ticketId: ticket.id,
  });
}
