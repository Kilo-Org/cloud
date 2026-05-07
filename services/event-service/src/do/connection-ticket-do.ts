import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

const ticketStateSchema = z.object({
  userId: z.string().min(1),
  expiresAt: z.number().int(),
});

export const connectionTicketConsumeResponseSchema = z.object({
  userId: z.string().min(1),
});

type TicketState = z.infer<typeof ticketStateSchema>;
export type TicketMintRequest = TicketState;
export type ConnectionTicketConsumeResponse = z.infer<typeof connectionTicketConsumeResponseSchema>;

export class ConnectionTicketDO extends DurableObject<Env> {
  async mint(input: TicketMintRequest): Promise<void> {
    await this.ctx.storage.put<TicketState>('ticket', input);
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  async consume(): Promise<ConnectionTicketConsumeResponse | null> {
    const userId = await this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<TicketState>('ticket');
      const parsed = ticketStateSchema.safeParse(stored);
      if (!parsed.success || parsed.data.expiresAt <= Date.now()) {
        await txn.delete('ticket');
        return null;
      }

      await txn.delete('ticket');
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
