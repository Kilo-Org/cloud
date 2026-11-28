/**
 * Authentication middleware for API routes
 *
 * Uses internal API key authentication for backend-to-backend calls.
 * The backend is trusted to call the correct endpoints - userId/orgId
 * are extracted from URL path parameters for logging context.
 */

import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from '@kilocode/encryption';
import {
  INTERNAL_CALLER_HEADER,
  callerLabel,
  observeInternalAuth,
} from '@kilocode/worker-utils/internal-auth-observation';
import type { HonoContext } from '../index';
import { logger } from './logger';
import { resError } from '@kilocode/worker-utils';
import { expectedSecret, secretUnavailableResponse } from '../secrets';
import { secretsComparison, type CheckedSecret } from '../secrets-compare';

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

  if (!timingSafeEqual(apiKeyHeader, secret)) {
    return { success: false, error: 'Invalid internal API key' };
  }

  return { success: true };
}

/**
 * Hono middleware for authenticating internal API requests.
 * Validates X-Internal-API-Key header against INTERNAL_API_SECRET from the source that
 * `SECRETS_SOURCE` selects (src/secrets.ts).
 * Does NOT set user context - routes extract userId/orgId from URL path.
 */
export const internalApiMiddleware = createMiddleware<HonoContext>(async (c, next) => {
  // The /api/callbacks subtree authenticates with a scoped X-Callback-Token
  // (see routes/callbacks.ts via verifyCallbackToken), NOT the internal API key.
  // It is mounted under /api, so the `/api/*` matcher for this middleware would
  // otherwise 401 completion callbacks before they reach the token-validating
  // handler — orphaning the webhook request in `inprogress`. Exempt the subtree
  // here; every route under it self-authenticates. (c.req.path is the full
  // request path under Hono's app.route() mounting, verified for hono@4.12.18.)
  if (c.req.path.startsWith('/api/callbacks/')) {
    return next();
  }

  const apiKeyHeader = c.req.header(INTERNAL_API_KEY_HEADER) ?? null;
  const expected = await expectedSecret(c.env, 'INTERNAL_API_SECRET', apiKeyHeader);
  if (expected.status === 'refused') {
    return secretUnavailableResponse('internal-api', expected.reason);
  }

  if (expected.status === 'read' && !expected.secret) {
    logger.error('INTERNAL_API_SECRET not configured');
    return c.json(resError('Internal server error'), 500);
  }

  // A keyless request under `sts` read no secret; validation refuses it as missing before any
  // comparison.
  const checked: CheckedSecret = {
    route: 'internal-api',
    source: expected.source,
    selected: expected.status === 'read' ? expected.secret : '',
  };
  const result = validateInternalApiKey(apiKeyHeader, checked.selected);

  if (!result.success) {
    logger.warn('Internal API authentication failed', {
      error: result.error,
      route: checked.route,
      secret: 'INTERNAL_API_SECRET',
      source: checked.source,
      reason: apiKeyHeader ? 'invalid' : 'missing',
    });
    // A refused key starts at most one background check of this name per isolate when enabled
    // (src/secrets-compare.ts); a keyless request starts none. Neither changes this answer.
    if (apiKeyHeader) secretsComparison.refused(c.env, () => c.executionCtx, checked);
    return c.json(resError('Unauthorized'), 401);
  }

  logger.info('Internal API request authenticated');
  observeInternalAuth(
    'webhook-agent-ingest',
    'api',
    'legacy_shared_secret',
    callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
  );
  // Background source comparison, off unless enabled (src/secrets-compare.ts). It never changes
  // this answer.
  secretsComparison.admitted(c.env, () => c.executionCtx, checked);

  await next();
});
