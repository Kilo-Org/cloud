export { UtsSignerDO } from './dos/UtsSignerDO';

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env';
import { handleRequest } from './http';

/**
 * The default entrypoint is a `WorkerEntrypoint` class, not a plain handler object: a deployed
 * Worker delivers a service binding's `props` to `this.ctx.props` of an entrypoint class only, so
 * a plain object would never see the feed Worker's `props.caller`. Its `fetch` serves every route,
 * so placement still covers it; the class defines no RPC method.
 */
export default class UtsMint extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return await handleRequest(request, this.env, this.ctx);
  }
}
