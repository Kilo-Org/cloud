import { createMiddleware } from 'hono/factory';
import { verifyAgentJWT, type AgentJWTPayload } from '../util/jwt.util';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

/**
 * Resolves a secret value from either a `SecretsStoreSecret` (production, has `.get()`)
 * or a plain string (test env vars set in wrangler.test.jsonc).
 */
async function resolveSecret(binding: SecretsStoreSecret | string): Promise<string> {
  if (typeof binding === 'string') return binding;
  return binding.get();
}

/**
 * Auth middleware for mayor tool routes. Validates a Gastown agent JWT
 * and checks that the JWT's `townId` matches the `:townId` route param.
 *
 * Unlike the rig-scoped `authMiddleware` (which checks `rigId` match),
 * this validates `townId` — the mayor operates cross-rig.
 *
 * Sets `agentJWT` on the Hono context.
 */
export const mayorAuthMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.toLowerCase().startsWith('bearer ')) {
    return c.json(resError('Authentication required'), 401);
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json(resError('Missing token'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    console.error('[mayor-auth] GASTOWN_JWT_SECRET not configured');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyAgentJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  // Verify the townId in the JWT matches the route param
  const townId = c.req.param('townId');
  if (townId && result.payload.townId !== townId) {
    return c.json(resError('Token townId does not match route'), 403);
  }

  c.set('agentJWT', result.payload);
  return next();
});
