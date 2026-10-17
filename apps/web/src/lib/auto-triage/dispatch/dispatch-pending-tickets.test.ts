const mockDispatchTriage = jest.fn();
const mockGetAgentConfigForOwner = jest.fn();
const mockPrepareTriagePayload = jest.fn();

jest.mock('@/lib/auto-triage/client/triage-worker-client', () => ({
  triageWorkerClient: {
    dispatchTriage: (...args: unknown[]) => mockDispatchTriage(...args),
  },
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: (...args: unknown[]) => mockGetAgentConfigForOwner(...args),
}));

jest.mock('@/lib/auto-triage/triggers/prepare-triage-payload', () => ({
  prepareTriagePayload: (...args: unknown[]) => mockPrepareTriagePayload(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { auto_triage_tickets, organizations, type AutoTriageTicket } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { tryDispatchPendingTickets } from './dispatch-pending-tickets';
import { updateTriageTicketStatus } from '../db/triage-tickets';
import { AUTO_TRIAGE_CONSTANTS } from '../core/constants';

type TicketOwner = { type: 'org'; id: string; userId: string };

type DispatchPayload = { ticketId: string };
const payloadOf = (call: unknown[]): string => (call[0] as DispatchPayload).ticketId;

const REPO = 'test-org/dispatch-pending-tickets';

describe('tryDispatchPendingTickets', () => {
  let organizationId: string;
  let owner: TicketOwner;
  let ticketSequence = 0;

  beforeAll(async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: `Dispatch Pending Tickets ${Date.now()}` })
      .returning({ id: organizations.id });
    organizationId = organization.id;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    owner = { type: 'org', id: organizationId, userId: 'test-kilo-user' };
    mockGetAgentConfigForOwner.mockResolvedValue({ is_enabled: true });
    mockPrepareTriagePayload.mockImplementation(async ({ ticketId }: { ticketId: string }) => ({
      ticketId,
    }));
    mockDispatchTriage.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await db
      .delete(auto_triage_tickets)
      .where(
        and(
          eq(auto_triage_tickets.owned_by_organization_id, organizationId),
          eq(auto_triage_tickets.repo_full_name, REPO)
        )
      );
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organizationId));
  });

  async function insertPendingTicket(): Promise<AutoTriageTicket> {
    ticketSequence++;
    const [ticket] = await db
      .insert(auto_triage_tickets)
      .values({
        owned_by_organization_id: organizationId,
        repo_full_name: REPO,
        issue_number: ticketSequence,
        issue_url: `https://example.com/issues/${ticketSequence}`,
        issue_title: `Ticket ${ticketSequence}`,
        issue_author: 'someone',
        issue_type: 'issue',
      })
      .returning();
    return ticket;
  }

  async function countByStatus(status: 'pending' | 'analyzing'): Promise<number> {
    const rows = await db
      .select({ id: auto_triage_tickets.id })
      .from(auto_triage_tickets)
      .where(
        and(
          eq(auto_triage_tickets.owned_by_organization_id, organizationId),
          eq(auto_triage_tickets.status, status)
        )
      );
    return rows.length;
  }

  it('processes disjoint ticket sets across concurrent calls', async () => {
    const tickets = [
      await insertPendingTicket(),
      await insertPendingTicket(),
      await insertPendingTicket(),
    ];

    // Two concurrent calls each dispatch a disjoint subset covering all tickets.
    const [first, second] = await Promise.all([
      tryDispatchPendingTickets(owner),
      tryDispatchPendingTickets(owner),
    ]);

    expect(first.dispatched + second.dispatched).toBe(tickets.length);
    expect(mockDispatchTriage).toHaveBeenCalledTimes(tickets.length);

    const dispatchedTicketIds: string[] = mockDispatchTriage.mock.calls.map(payloadOf);
    expect(new Set(dispatchedTicketIds).size).toBe(dispatchedTicketIds.length);
    for (const ticket of tickets) {
      expect(dispatchedTicketIds).toContain(ticket.id);
    }

    expect(await countByStatus('analyzing')).toBe(tickets.length);
    expect(await countByStatus('pending')).toBe(0);
  });

  it('keeps dispatch volume within the per-owner limit across concurrent calls', async () => {
    const cap = AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER;
    for (let i = 0; i < cap + 3; i++) {
      await insertPendingTicket();
    }

    await Promise.all([tryDispatchPendingTickets(owner), tryDispatchPendingTickets(owner)]);

    const analyzing = await countByStatus('analyzing');
    expect(analyzing).toBeLessThanOrEqual(cap);
    expect(await countByStatus('pending')).toBe(cap + 3 - analyzing);
  });

  it('does not dispatch when no slots are available', async () => {
    const cap = AUTO_TRIAGE_CONSTANTS.MAX_CONCURRENT_TICKETS_PER_OWNER;
    const analyzingTickets: AutoTriageTicket[] = [];
    for (let i = 0; i < cap; i++) {
      analyzingTickets.push(await insertPendingTicket());
    }
    await db
      .update(auto_triage_tickets)
      .set({ status: 'analyzing' })
      .where(
        and(
          eq(auto_triage_tickets.owned_by_organization_id, organizationId),
          eq(auto_triage_tickets.status, 'pending')
        )
      );
    await insertPendingTicket();

    const result = await tryDispatchPendingTickets(owner);

    expect(result.dispatched).toBe(0);
    expect(mockDispatchTriage).not.toHaveBeenCalled();
    expect(await countByStatus('analyzing')).toBe(analyzingTickets.length);
    expect(await countByStatus('pending')).toBe(1);
  });

  it('releases a claimed slot back to pending when dispatch fails', async () => {
    const ticket = await insertPendingTicket();
    mockDispatchTriage.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await tryDispatchPendingTickets(owner);

    expect(result.dispatched).toBe(0);
    expect(result.pending).toBe(1);

    const [row] = await db
      .select({ status: auto_triage_tickets.status })
      .from(auto_triage_tickets)
      .where(eq(auto_triage_tickets.id, ticket.id));
    expect(row?.status).toBe('pending');
  });

  it('holds at most one reservation at a time while dispatching', async () => {
    for (let i = 0; i < 3; i++) {
      await insertPendingTicket();
    }

    const analyzingAtDispatch: number[] = [];
    mockDispatchTriage.mockImplementation(async () => {
      analyzingAtDispatch.push(await countByStatus('analyzing'));
    });

    await tryDispatchPendingTickets(owner);

    expect(analyzingAtDispatch).toEqual([1, 2, 3]);
    expect(await countByStatus('analyzing')).toBe(3);
  });

  it('does not leave an error message on a ticket that recovers from a dispatch failure', async () => {
    const ticket = await insertPendingTicket();
    mockDispatchTriage.mockRejectedValueOnce(new TypeError('fetch failed'));

    await tryDispatchPendingTickets(owner);

    const [afterFailure] = await db
      .select({
        status: auto_triage_tickets.status,
        errorMessage: auto_triage_tickets.error_message,
      })
      .from(auto_triage_tickets)
      .where(eq(auto_triage_tickets.id, ticket.id));
    expect(afterFailure?.status).toBe('pending');
    expect(afterFailure?.errorMessage).toBeNull();

    await tryDispatchPendingTickets(owner);

    const [afterRecovery] = await db
      .select({
        status: auto_triage_tickets.status,
        errorMessage: auto_triage_tickets.error_message,
      })
      .from(auto_triage_tickets)
      .where(eq(auto_triage_tickets.id, ticket.id));
    expect(afterRecovery?.status).toBe('analyzing');
    expect(afterRecovery?.errorMessage).toBeNull();
  });

  it('does not reset an analyzing ticket without the expected status', async () => {
    const ticket = await insertPendingTicket();
    await db
      .update(auto_triage_tickets)
      .set({ status: 'failed' })
      .where(eq(auto_triage_tickets.id, ticket.id));

    await updateTriageTicketStatus(ticket.id, 'pending', {
      expectedStatus: 'analyzing',
    });

    const [row] = await db
      .select({ status: auto_triage_tickets.status })
      .from(auto_triage_tickets)
      .where(eq(auto_triage_tickets.id, ticket.id));
    expect(row?.status).toBe('failed');
  });
});
