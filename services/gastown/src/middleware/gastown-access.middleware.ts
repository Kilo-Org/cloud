import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { resError } from '../util/res.util';

/**
 * Requires the `gastownAccess` claim minted after the `gastown-access`
 * PostHog flag check. Admins do not bypass this check.
 *
 * Must run after `kiloAuthMiddleware`, which sets `kiloGastownAccess`.
 */
export const gastownAccessMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  if (!c.get('kiloGastownAccess')) {
    return c.json(resError('Gastown access required'), 403);
  }
  return next();
});

/**
 * Requires the `gastownAccess` claim or an admin token, like
 * `gastownProcedure` does for tRPC. User routes also accept plain Kilo API
 * keys, which never carry the claim, so this keeps those keys out once the
 * flag is off.
 *
 * Must run after `kiloAuthMiddleware`, which sets `kiloGastownAccess`.
 */
export const gastownRouteAccessMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  if (!c.get('kiloGastownAccess') && !c.get('kiloIsAdmin')) {
    return c.json(resError('Gastown access required'), 403);
  }
  return next();
});
