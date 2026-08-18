import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types.js';

/**
 * One-time nonce consumer for stream/terminal tickets.
 *
 * The nonce is an unguessable UUID minted inside a signed JWT. This DO makes
 * the first use of a nonce the only successful one: `consume()` atomically
 * marks the nonce used and returns true, or returns false on any replay.
 */
export class StreamTicketNonceDO extends DurableObject<Env> {
  async consume(): Promise<boolean> {
    return this.ctx.storage.transaction(async txn => {
      const used = await txn.get('used');
      if (used !== undefined) {
        return false;
      }
      await txn.put('used', { usedAt: Date.now() });
      return true;
    });
  }
}

/**
 * The only consume call site for stream/terminal ticket nonces. Kept separate
 * from `validateStreamTicket` so signature/type/expiry/audience validation
 * never consumes the nonce.
 */
export async function consumeStreamTicketNonce(env: Env, nonce: string): Promise<boolean> {
  const doId = env.STREAM_TICKET_NONCE_DO.idFromName(nonce);
  const stub = env.STREAM_TICKET_NONCE_DO.get(doId);
  return stub.consume();
}
