import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { resError } from '../util/res.util';
import { logger } from '../util/log.util';
import {
  authorizeOrganization,
  TownAuthorizationUnavailableError,
} from '../util/town-authorization.util';

/**
 * Verifies the authenticated Kilo user is a member of the org identified
 * by the `:orgId` route param using current authorization. Collection routes
 * can contain modern towns, so cached JWT organization claims are never safe.
 *
 * Sets `orgId` and `orgRole` on the Hono context for downstream handlers.
 * Must run after `kiloAuthMiddleware` (which sets `kiloUserId` and `kiloOrgMemberships`).
 */
export const orgAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const orgId = c.req.param('orgId');
  if (!orgId) return c.json(resError('Missing orgId'), 400);
  const userId = c.get('kiloUserId');
  if (!userId) return c.json(resError('Authentication required'), 401);

  let role: string;
  try {
    const authorization = await authorizeOrganization(
      c.env,
      orgId,
      userId,
      c.get('kiloApiTokenPepper')
    );
    if (!authorization || !('role' in authorization)) {
      return c.json(resError('Not an org member'), 403);
    }
    role = authorization.role;
  } catch (error) {
    if (error instanceof TownAuthorizationUnavailableError) {
      return c.json(resError('Authorization unavailable'), 503);
    }
    throw error;
  }

  c.set('orgId', orgId);
  c.set('orgRole', role);
  logger.setTags({ orgId });
  await next();
});
