import { createMiddleware } from 'hono/factory';
import { extractBearerToken, verifyKiloToken } from '@kilocode/worker-utils';
import { SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE } from '@kilocode/session-ingest-contracts';

import type { Env } from '../env';

/**
 * Audience-bound auth middleware for the internal runtime-control surface.
 *
 * The web app's Local Runtime Control module signs a five-minute,
 * audience-bound JWT and sends it on every request. The middleware:
 *
 * - Accepts only the exact `Authorization: Bearer <token>` format and
 *   nothing else (no query string, no websocket upgrade fallback).
 * - Reads `NEXTAUTH_SECRET_PROD` from the bindings and verifies the token
 *   against it with `verifyKiloToken(token, secret, { audience })`.
 * - Derives `user_id` solely from the signed payload — never from a query
 *   parameter, path parameter, or request body.
 * - Returns a safe 401 on every failure path without logging the token,
 *   the request body, or the raw verifier error.
 */
export const runtimeControlAuthMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: {
    user_id: string;
  };
}>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const secret = await c.env.NEXTAUTH_SECRET_PROD.get();

  let kiloUserId: string;
  try {
    const payload = await verifyKiloToken(token, secret, {
      audience: SESSION_INGEST_RUNTIME_CONTROL_AUDIENCE,
    });
    kiloUserId = payload.kiloUserId;
  } catch {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  c.set('user_id', kiloUserId);
  return next();
});
