import { Hono } from 'hono';
import { ZodError } from 'zod';

import { localRuntimeListResponseSchema } from '@kilocode/session-ingest-contracts';

import type { Env } from '../env';
import { getUserConnectionDO } from '../dos/UserConnectionDO';

type ApiContext = {
  Bindings: Env;
  Variables: {
    user_id: string;
  };
};

export const runtimeControlApi = new Hono<ApiContext>();

/**
 * Read-only runtime list for the bound user. The user identity comes solely
 * from the auth middleware's signed payload — never from the request — and
 * the response is shape-validated against the cross-service contract before
 * leaving the worker. Any upstream or schema failure collapses to a generic
 * 500; the raw DO/parser error is never propagated to the client or logged
 * alongside the token.
 */
runtimeControlApi.get('/runtimes', async c => {
  const kiloUserId = c.get('user_id');
  try {
    const stub = getUserConnectionDO(c.env, { kiloUserId });
    const runtimes = await stub.getRuntimePresence();
    const payload = localRuntimeListResponseSchema.parse({ runtimes });
    return c.json(payload, 200);
  } catch (err) {
    if (err instanceof ZodError) {
      // The DO is required to satisfy the contract; an unexpected shape
      // indicates a wire-level bug and is not the client's problem to debug.
      console.error('[runtime-control] DO returned an unexpected runtime shape');
    } else {
      console.error('[runtime-control] runtime list fetch failed');
    }
    return c.json({ success: false, error: 'Internal error' }, 500);
  }
});
