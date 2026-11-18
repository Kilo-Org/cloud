import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from '@kilocode/encryption';
import { z } from 'zod';

import type { Env } from '../env';

const ticketStateSchema = z.object({
  userId: z.string().min(1),
  expiresAt: z.number().int(),
  secret: z.string().min(1),
});

type TicketState = z.infer<typeof ticketStateSchema>;
export type TicketMintRequest = TicketState;
export type ConnectionTicketConsumeResponse = { userId: string };

export class ConnectionTicketDO extends DurableObject<Env> {
  async mint(input: TicketMintRequest): Promise<void> {
    await this.ctx.storage.put<TicketState>('ticket', input);
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  async consume(secret: string): Promise<ConnectionTicketConsumeResponse | null> {
    const userId = await this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<TicketState>('ticket');
      // Any attempt burns the ticket, so a wrong secret cannot be retried.
      await txn.delete('ticket');
      const parsed = ticketStateSchema.safeParse(stored);
      if (
        !parsed.success ||
        parsed.data.expiresAt <= Date.now() ||
        !timingSafeEqual(parsed.data.secret, secret)
      ) {
        return null;
      }
      return parsed.data.userId;
    });

    if (!userId) {
      return null;
    }

    await this.ctx.storage.deleteAlarm();
    return { userId } satisfies ConnectionTicketConsumeResponse;
  }

  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<TicketState>('ticket');
    const parsed = ticketStateSchema.safeParse(stored);
    if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
      await this.ctx.storage.delete('ticket');
    }
  }
}
