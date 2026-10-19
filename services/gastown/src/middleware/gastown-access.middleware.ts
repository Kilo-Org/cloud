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
