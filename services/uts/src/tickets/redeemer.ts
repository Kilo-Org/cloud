import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { readConfig, type Env } from '../env';
import { identityStoreBinding } from '../grants/binding';
import { type TicketRedeemResult, redeemTicket } from './routes';
import { ticketAccess } from './store';

const CallerPropsSchema = z.strictObject({ caller: z.string().min(1) });

/**
 * The named entrypoint a service that takes tickets binds, with its own deployed name as
 * `props.caller` (as the feed Worker binds `SignerKeys`). Only a deploy in the account can set
 * props, so the caller is the binding's Worker. The caller names the audience, the purpose and the
 * resource (null: none) it opens. `redeemTicket` refuses a caller outside `TICKET_REDEEMERS`, an
 * audience that is not the caller's own and a malformed purpose or resource before any statement
 * runs.
 * Placement does not apply to a named entrypoint, so the redemption runs beside the caller and
 * makes one round trip to the identity store's primary.
 */
export class TicketRedeemer extends WorkerEntrypoint<Env> {
  async redeem(
    ticket: unknown,
    audience: unknown,
    purpose: unknown,
    resource: unknown
  ): Promise<TicketRedeemResult> {
    const config = readConfig(this.env);
    const binding = identityStoreBinding(this.env);
    if (binding.kind === 'unprovisioned') return { status: 'refused' };
    const caller = CallerPropsSchema.safeParse(this.ctx.props).data?.caller ?? null;
    return await redeemTicket(
      { config, tickets: ticketAccess(binding.connectionString, this.ctx) },
      caller,
      ticket,
      audience,
      purpose,
      resource
    );
  }
}
