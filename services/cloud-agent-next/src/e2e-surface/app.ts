/**
 * The e2e-only Hono surface. It is mounted exclusively from `src/e2e-entry.ts`,
 * which the production entry (`src/index.ts`) never imports, so these routes are
 * unreachable on the production Worker by construction rather than by a flag.
 *
 * Every `/__e2e/*` route passes two independent gates, in this order:
 *
 * 1. `e2eSurfaceSecretMiddleware` compares the presented `x-internal-api-key`
 *    against the Worker's `INTERNAL_API_SECRET` with a constant-time compare. An
 *    unset or empty binding, or a missing/mismatched header, fails closed with
 *    401 before any JWT verification and before `authMiddleware` dereferences
 *    `c.env.HYPERDRIVE`.
 * 2. `e2eSurfaceAuthMiddleware` runs the production `authMiddleware` (a valid
 *    Kilo JWT). A valid JWT never substitutes for the secret and a correct secret
 *    never substitutes for the JWT.
 *
 * Exactly one method+path is exempt from both gates: `POST /__e2e/callbacks/:token`,
 * callback ingest, authorized by its own unguessable path token because
 * `src/callbacks/delivery.ts` sends no Kilo credential and treats a 401 as
 * non-retryable. `POST /__e2e/callbacks` (mint), `GET`/`DELETE` on the same path,
 * and any extra or trailing path segment stay behind both gates.
 */

import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { Context, Next } from 'hono';
import { timingSafeEqual } from '@kilocode/encryption';
import { authMiddleware } from '../middleware/auth.js';
import type { HonoContext } from '../hono-context.js';
import { handleAllocationInspect } from './allocation.js';
import {
  handleCallbackDelete,
  handleCallbackIngest,
  handleCallbackMint,
  handleCallbackRead,
} from './callbacks.js';

const INTERNAL_API_KEY_HEADER = 'x-internal-api-key';
const CALLBACK_INGEST_PATH = /^\/__e2e\/callbacks\/[^/]+$/;

/** The one method+path exempt from the secret and JWT chain. */
export function isCallbackIngestRequest(method: string, path: string): boolean {
  return method === 'POST' && CALLBACK_INGEST_PATH.test(path);
}

/**
 * Gate one: the e2e-scoped internal API secret. It runs before the JWT gate, so
 * a bad secret is rejected without verifying a token or touching Hyperdrive,
 * and a Worker with no usable Hyperdrive still returns 401 rather than a
 * framework 500.
 */
export const e2eSurfaceSecretMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    if (isCallbackIngestRequest(c.req.method, c.req.path)) {
      await next();
      return;
    }
    const expected = c.env.INTERNAL_API_SECRET;
    const presented = c.req.header(INTERNAL_API_KEY_HEADER);
    if (!expected || !presented || !timingSafeEqual(presented, expected)) {
      return new Response('Unauthorized', { status: 401 });
    }
    await next();
  }
);

/** Gate two: the production JWT middleware, exempt for the callback ingest. */
export const e2eSurfaceAuthMiddleware = createMiddleware<HonoContext>(
  async (c: Context<HonoContext>, next: Next) => {
    if (isCallbackIngestRequest(c.req.method, c.req.path)) {
      await next();
      return;
    }
    return authMiddleware(c as Parameters<typeof authMiddleware>[0], next);
  }
);

export const e2eSurfaceApp = new Hono<HonoContext>();

e2eSurfaceApp.use('/__e2e/*', e2eSurfaceSecretMiddleware);
e2eSurfaceApp.use('/__e2e/*', e2eSurfaceAuthMiddleware);

e2eSurfaceApp.get('/__e2e/inspect/allocation/:cloudAgentSessionId', handleAllocationInspect);
e2eSurfaceApp.post('/__e2e/callbacks', handleCallbackMint);
e2eSurfaceApp.post('/__e2e/callbacks/:token', handleCallbackIngest);
e2eSurfaceApp.get('/__e2e/callbacks/:token', handleCallbackRead);
e2eSurfaceApp.delete('/__e2e/callbacks/:token', handleCallbackDelete);
