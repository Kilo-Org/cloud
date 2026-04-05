/**
 * Admin authentication middleware for service-to-service communication
 * Validates requests using a shared secret passed via X-Admin-Secret header
 */

import { createMiddleware } from 'hono/factory';
import { logger } from './logger';
import type { HonoContext } from '../ai-attribution.worker';

const ADMIN_SECRET_HEADER = 'X-Admin-Secret';

/**
 * Validates the admin shared secret from request headers
 */
export function validateAdminSecret(
  secretHeader: string | null,
  expectedSecret: string
): { success: true } | { success: false; error: string } {
  if (!secretHeader) {
    return { success: false, error: `Missing ${ADMIN_SECRET_HEADER} header` };
  }

  if (secretHeader !== expectedSecret) {
    return { success: false, error: 'Invalid admin secret' };
  }

  return { success: true };
}

/**
 * Hono middleware for authenticating admin/service-to-service requests
 * Expects the shared secret in the X-Admin-Secret header
 */
export const adminAuthMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const secretHeader = c.req.header(ADMIN_SECRET_HEADER);
  const expectedSecret = await c.env.ADMIN_SECRET.get();

  const result = validateAdminSecret(secretHeader ?? null, expectedSecret);

  if (!result.success) {
    logger.warn('Admin authentication failed', { error: result.error });
    return c.json({ success: false, error: result.error }, 401);
  }

  logger.info('Admin request authenticated');

  await next();
});
