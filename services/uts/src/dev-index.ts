/**
 * The mint Worker's entry for `wrangler dev --env local` only: the deployed entry plus the
 * development signing route (`src/dev.ts`), with the same entrypoint class shape as `src/index.ts`.
 */
export { UtsSignerDO } from './dos/UtsSignerDO';

import { WorkerEntrypoint } from 'cloudflare:workers';
import { handleDevRequest } from './dev';
import type { Env } from './env';

export default class UtsMintDev extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    return await handleDevRequest(request, this.env, this.ctx);
  }
}
