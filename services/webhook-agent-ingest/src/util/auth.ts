/**
 * Authentication middleware for API routes
 *
 * Uses internal API key authentication for backend-to-backend calls.
 * The backend is trusted to call the correct endpoints - userId/orgId
 * are extracted from URL path parameters for logging context.
 */

import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { STS_WEBHOOK_AGENT_INGEST_INTERNAL_CALL } from '@kilocode/sts-contracts';
import {
  createInternalServiceReceiver,
  type InternalReceiverEnv,
  type InternalRouteContract,
} from '@kilocode/worker-utils/internal-service-receiver';
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
import { compareSecretsOnce } from '../secrets-compare';

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
  // `INTERNAL_CREDENTIAL_ACCEPT` selects the shared secret, an STS token or either; the callback
  // subtree above never reaches it.
  const receiverEnv: Env & InternalReceiverEnv = c.env;
  const refusal = await internalReceiver.admit(
    c.req.raw,
    receiverEnv,
    API_ROUTE,
    () => legacyRefusal(c),
    { waitUntil: promise => c.executionCtx.waitUntil(promise) }
  );
  if (refusal !== null) return refusal;

  await next();
});

/** `/api/*` but the callbacks: the web app's trigger routes, one scope, sent only by `web`. */
const API_ROUTE: InternalRouteContract = {
  label: 'api',
  scope: STS_WEBHOOK_AGENT_INGEST_INTERNAL_CALL.scope,
  workloads: ['web'],
  legacyHeader: INTERNAL_API_KEY_HEADER,
};

export const internalReceiver = createInternalServiceReceiver({
  receiver: 'webhook-agent-ingest',
  audience: STS_WEBHOOK_AGENT_INGEST_INTERNAL_CALL.audience,
  routes: [API_ROUTE],
});

/** The legacy check, unchanged: the shared secret in `X-Internal-API-Key`. */
async function legacyRefusal(c: Context<HonoContext>): Promise<Response | null> {
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
  const result = validateInternalApiKey(
    apiKeyHeader,
    expected.status === 'read' ? expected.secret : ''
  );

  if (!result.success) {
    logger.warn('Internal API authentication failed', { error: result.error });
    return c.json(resError('Unauthorized'), 401);
  }

  logger.info('Internal API request authenticated');
  observeInternalAuth(
    'webhook-agent-ingest',
    API_ROUTE.label,
    'legacy_shared_secret',
    callerLabel(c.req.header(INTERNAL_CALLER_HEADER) ?? null)
  );
  // Pre-flip STS copy check, off unless enabled (src/secrets-compare.ts). It runs in the
  // background and never changes this answer.
  compareSecretsOnce(c.env, () => c.executionCtx);
  return null;
}
