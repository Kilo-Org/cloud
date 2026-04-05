import { createMiddleware } from 'hono/factory';
import type { GastownEnv } from '../gastown.worker';
import { writeEvent } from '../util/analytics.util';

/**
 * Middleware that logs admin access to town routes.
 *
 * Must run AFTER kiloAuthMiddleware (which sets kiloIsAdmin and kiloUserId).
 * Only emits an analytics event when the request is from an admin user —
 * regular user traffic is unaffected.
 *
 * The event is written to Cloudflare Analytics Engine with:
 * - event: 'admin.town_access'
 * - userId: the admin's user ID
 * - townId: the town being accessed
 * - route: the HTTP method + path
 */
export const adminAuditMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const isAdmin = c.get('kiloIsAdmin');
  if (!isAdmin) return next();

  const adminUserId = c.get('kiloUserId');
  const townId = c.req.param('townId');
  const method = c.req.method;
  const path = c.req.path;

  console.log(
    `[admin-audit] Admin ${adminUserId} accessing town ${townId ?? 'N/A'}: ${method} ${path}`
  );

  writeEvent(c.env, {
    event: 'admin.town_access',
    delivery: 'http',
    route: `${method} ${path}`,
    userId: adminUserId,
    townId: townId ?? undefined,
  });

  return next();
});
