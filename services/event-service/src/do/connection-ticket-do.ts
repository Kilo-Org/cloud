import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

const ticketStateSchema = z.object({
  userId: z.string().min(1),
  secret: z.string().min(1),
  expiresAt: z.number().int(),
});

export const connectionTicketConsumeResponseSchema = z.object({
  userId: z.string().min(1),
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
 * object id is not a secret on its own: a ticket is the object id joined with
 * its own `secret`. The mint path in `index.ts` builds both in one place and
 * returns them in one response to the authenticated caller, so the object id
 * never travels apart from its secret.
 *
 * A ticket is single use: any redemption attempt burns it, whether or not the
 * presented secret matches, so a wrong secret cannot be retried. Only a
 * matching, unexpired secret returns the `userId`.
 */
export class ConnectionTicketDO extends DurableObject<Env> {
  async mint(input: TicketMintRequest): Promise<void> {
    await this.ctx.storage.put<TicketState>('ticket', input);
    await this.ctx.storage.setAlarm(input.expiresAt);
  }

  async consume(secret: string): Promise<ConnectionTicketConsumeResponse | null> {
    const userId = await this.ctx.storage.transaction(async txn => {
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
