/**
 * Authentication middleware for API routes
 *
 * Uses internal API key authentication for backend-to-backend calls.
 * The backend is trusted to call the correct endpoints - userId/orgId
 * are extracted from URL path parameters for logging context.
 */

import { createMiddleware } from 'hono/factory';
import type { HonoContext } from '../index';
import { logger } from './logger';
import { resError } from '@kilocode/worker-utils';

/** Header name for internal API key */
export const INTERNAL_API_KEY_HEADER = 'X-Internal-API-Key';

/**
 * Validates the internal API key header against the configured secret.
 * Returns success with no user context - the backend is trusted.
 */
export function validateInternalApiKey(
  apiKeyHeader: string | null,
  secret: string
): { success: true } | { success: false; error: string } {
  if (!apiKeyHeader || apiKeyHeader.length === 0) {
    return { success: false, error: 'Missing internal API key' };
  }

  if (apiKeyHeader !== secret) {
    return { success: false, error: 'Invalid internal API key' };
  }

  return { success: true };
}

/**
 * Hono middleware for authenticating internal API requests.
 * Validates X-Internal-API-Key header against INTERNAL_API_SECRET.
 * Does NOT set user context - routes extract userId/orgId from URL path.
 */
export const internalApiMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  const apiKeyHeader = c.req.header(INTERNAL_API_KEY_HEADER);
  const secret = await c.env.INTERNAL_API_SECRET.get();

  if (!secret) {
    logger.error('INTERNAL_API_SECRET not configured');
    return c.json(resError('Internal server error'), 500);
  }

  const result = validateInternalApiKey(apiKeyHeader ?? null, secret);

  if (!result.success) {
    logger.warn('Internal API authentication failed', { error: result.error });
    return c.json(resError('Unauthorized'), 401);
  }

  logger.info('Internal API request authenticated');

  await next();
});
