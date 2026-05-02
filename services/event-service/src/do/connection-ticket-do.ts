import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

const ticketStateSchema = z.object({
  userId: z.string().min(1),
  expiresAt: z.number().int(),
  consumed: z.boolean().optional(),
});

const ticketMintRequestSchema = ticketStateSchema.omit({ consumed: true });
export const connectionTicketConsumeResponseSchema = z.object({
  userId: z.string().min(1),
});

type TicketState = z.infer<typeof ticketStateSchema>;
export type TicketMintRequest = z.infer<typeof ticketMintRequestSchema>;
export type ConnectionTicketConsumeResponse = z.infer<typeof connectionTicketConsumeResponseSchema>;

export class ConnectionTicketDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/mint') {
      return this.mint(request);
    }
    if (request.method === 'POST' && url.pathname === '/consume') {
      return this.consume();
    }
    return new Response('Not found', { status: 404 });
  }

  private async mint(request: Request): Promise<Response> {
    const body: unknown = await request.json().catch(() => null);
    // This DO still exposes an HTTP-shaped fetch endpoint, so validate the
    // serialized JSON even though the caller is internal service code.
    const parsed = ticketMintRequestSchema.safeParse(body);
    if (!parsed.success) {
      return new Response('Invalid ticket', { status: 400 });
    }

    await this.ctx.storage.put<TicketState>('ticket', { ...parsed.data, consumed: false });
    return new Response(null, { status: 204 });
  }

  private async consume(): Promise<Response> {
    const userId = await this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<TicketState>('ticket');
      const parsed = ticketStateSchema.safeParse(stored);
      if (!parsed.success || parsed.data.consumed || parsed.data.expiresAt <= Date.now()) {
        await txn.delete('ticket');
        return null;
      }

      await txn.put<TicketState>('ticket', { ...parsed.data, consumed: true });
      return parsed.data.userId;
    });

    if (!userId) {
      return new Response('Unauthorized', { status: 401 });
    }

    const response = { userId } satisfies ConnectionTicketConsumeResponse;
    return Response.json(response);
  }
}
