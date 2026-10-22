import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

const ticketStateSchema = z.object({
  userId: z.string().min(1),
  deviceSessionId: z.string().min(1).optional(),
  secret: z.string().min(1),
  expiresAt: z.number().int(),
});

export const connectionTicketConsumeResponseSchema = z.object({
  userId: z.string().min(1),
  deviceSessionId: z.string().min(1).optional(),
});

type TicketState = z.infer<typeof ticketStateSchema>;
export type TicketMintRequest = TicketState;
export type ConnectionTicketConsumeResponse = z.infer<typeof connectionTicketConsumeResponseSchema>;

const encoder = new TextEncoder();

function secretsMatch(stored: string, presented: string): boolean {
  const a = encoder.encode(stored);
  const b = encoder.encode(presented);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/**
 * One object per ticket. The Worker addresses it with `newUniqueId()`, so the
 * object id is not a secret: the ticket also carries `secret`, and only a
 * matching secret consumes the ticket.
 */
export class ConnectionTicketDO extends DurableObject<Env> {
  async mint(input: TicketMintRequest): Promise<void> {
    await this.ctx.storage.put<TicketState>('ticket', input);
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  async consume(secret: string): Promise<ConnectionTicketConsumeResponse | null> {
    const state = await this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<TicketState>('ticket');
      const parsed = ticketStateSchema.safeParse(stored);
      await txn.delete('ticket');
      if (
        !parsed.success ||
        parsed.data.expiresAt <= Date.now() ||
        !secretsMatch(parsed.data.secret, secret)
      ) {
        return null;
      }

      return {
        userId: parsed.data.userId,
        ...(parsed.data.deviceSessionId ? { deviceSessionId: parsed.data.deviceSessionId } : {}),
      };
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
