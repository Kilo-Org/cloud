/**
 * Local stand-in entrypoint for the session-ingest Worker used by the
 * no-acknowledgement E2E stand-in only. `createSessionForCloudAgent` resolves
 * `undefined` (the shape of a worker without acknowledgement support); every
 * other call dispatches to the real implementation. Run with:
 *   pnpm --filter session-ingest exec wrangler dev --config wrangler.standin.jsonc
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { SessionIngestRPC as RealSessionIngestRPC } from './session-ingest-rpc';
import type { Env } from './env';

export { RealSessionIngestRPC };

/**
 * Named entrypoint that answers the create RPC with `undefined`. The stub
 * dispatches every other call to the real implementation.
 */
export class SessionIngestRPC extends WorkerEntrypoint<Env> {
  // The stand-in simulates a worker without acknowledgement support: the
  // create RPC resolves to undefined, which the RPC contract documents as the
  // case callers must fail closed on. The declared return type narrows the
  // contract on purpose; the runtime RPC boundary carries whatever resolves.
  createSessionForCloudAgent(
    ..._params: Parameters<RealSessionIngestRPC['createSessionForCloudAgent']>
  ): Promise<undefined> {
    console.log('[stand-in] createSessionForCloudAgent resolves undefined');
    return Promise.resolve(undefined);
  }

  override async fetch(request: Request): Promise<Response> {
    return new RealSessionIngestRPC(this.ctx, this.env).fetch(request);
  }
}
