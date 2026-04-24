import { DurableObject } from 'cloudflare:workers';

const TICKET_TTL_MS = 30_000; // 30 seconds
const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

type TicketEntry = { userId: string; expiresAt: number };

/**
 * Per-user DO — one instance per userId, so tickets are user-scoped by construction.
 * This prevents cross-user ticket leakage without needing to embed userId in the
 * ticket itself.
 *
 * Flow:
 *   1. Client POSTs /connect/ticket with Bearer JWT
 *   2. Worker verifies JWT, calls ticketDO.create(userId) → ticket string
 *   3. Client connects to /connect?ticket=<ticket>
 *   4. Worker calls ticketDO.redeem(ticket) → userId (single-use, deleted on redeem)
 */
export class TicketDO extends DurableObject<Env> {
  async create(userId: string): Promise<string> {
    const ticket = crypto.randomUUID();
    await this.ctx.storage.put<TicketEntry>(`ticket:${ticket}`, {
      userId,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    await this.scheduleCleanup();
    return ticket;
  }

  async redeem(ticket: string): Promise<string | null> {
    const entry = await this.ctx.storage.get<TicketEntry>(`ticket:${ticket}`);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      await this.ctx.storage.delete(`ticket:${ticket}`);
      return null;
    }
    await this.ctx.storage.delete(`ticket:${ticket}`);
    return entry.userId;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const all = await this.ctx.storage.list<TicketEntry>({ prefix: 'ticket:' });
    const expired: string[] = [];
    let remaining = 0;
    for (const [key, entry] of all) {
      if (now > entry.expiresAt) {
        expired.push(key);
      } else {
        remaining++;
      }
    }
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired);
    }
    if (remaining > 0) {
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
