import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from '@kilocode/encryption';
import { z } from 'zod';

import type { Env } from '../env';

const ticketStateSchema = z.object({
  userId: z.string().min(1),
  deviceSessionId: z.string().min(1).optional(),
  expiresAt: z.number().int(),
  secret: z.string().min(1),
});

type TicketState = z.infer<typeof ticketStateSchema>;
export type TicketMintRequest = {
  userId: string;
  deviceSessionId?: string;
  expiresAt: number;
  secret: string;
};
export type ConnectionTicketConsumeResponse = {
  userId: string;
  deviceSessionId?: string;
};

function verifyTicket(stored: unknown, secret: string): ConnectionTicketConsumeResponse | null {
  const parsed = ticketStateSchema.safeParse(stored);
  if (
    !parsed.success ||
    parsed.data.expiresAt <= Date.now() ||
    !timingSafeEqual(parsed.data.secret, secret)
  ) {
    return null;
  }
  return {
    userId: parsed.data.userId,
    ...(parsed.data.deviceSessionId ? { deviceSessionId: parsed.data.deviceSessionId } : {}),
  };
}

export class ConnectionTicketDO extends DurableObject<Env> {
  async mint(input: TicketMintRequest): Promise<void> {
    await this.ctx.storage.put<TicketState>('ticket', input);
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  // Preserve a valid ticket while the Worker checks external dependencies.
  // Invalid attempts still burn the ticket, as they do during consumption.
  async inspect(secret: string): Promise<ConnectionTicketConsumeResponse | null> {
    return this.ctx.storage.transaction(async txn => {
      const state = verifyTicket(await txn.get<TicketState>('ticket'), secret);
      if (!state) await txn.delete('ticket');
      return state;
    });
  }

  async consume(secret: string): Promise<ConnectionTicketConsumeResponse | null> {
    const state = await this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<TicketState>('ticket');
      // Any attempt burns the ticket, so a wrong secret cannot be retried.
      await txn.delete('ticket');
      return verifyTicket(stored, secret);
    });

    if (!state) {
      return null;
    }

    await this.ctx.storage.deleteAlarm();
    return state satisfies ConnectionTicketConsumeResponse;
  }

  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<TicketState>('ticket');
    const parsed = ticketStateSchema.safeParse(stored);
    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      await this.ctx.storage.delete('ticket');
    }
  }
}
