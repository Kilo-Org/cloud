import { DurableObject } from 'cloudflare:workers';

const TICKET_TTL_MS = 30_000; // 30 seconds
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

type TicketEntry = { userId: string; expiresAt: number };

/**
 * Singleton DO that stores short-lived, single-use connection tickets.
 *
 * Flow:
 *   1. Client POSTs /connect/ticket with Bearer JWT
 *   2. Worker verifies JWT, calls ticketDO.create(userId) → ticket string
 *   3. Client connects to /connect?ticket=<ticket>
 *   4. Worker calls ticketDO.redeem(ticket) → userId (single-use, deleted on redeem)
 */
export class TicketDO extends DurableObject<Env> {
  private tickets = new Map<string, TicketEntry>();

  async create(userId: string): Promise<string> {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
    await this.scheduleCleanup();
    return ticket;
  }

  async redeem(ticket: string): Promise<string | null> {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    if (Date.now() > entry.expiresAt) return null;
    return entry.userId;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (now > entry.expiresAt) this.tickets.delete(ticket);
    }
    if (this.tickets.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }

  private async scheduleCleanup(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (!existing) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }
}
