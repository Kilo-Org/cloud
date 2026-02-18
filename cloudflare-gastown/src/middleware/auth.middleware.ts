import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { verifyAgentJWT, type AgentJWTPayload } from '../util/jwt.util';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export type AuthVariables = {
  agentJWT: AgentJWTPayload;
};

/**
 * Resolves a secret value from either a `SecretsStoreSecret` (production, has `.get()`)
 * or a plain string (test env vars set in wrangler.test.jsonc).
 */
async function resolveSecret(binding: SecretsStoreSecret | string): Promise<string> {
  if (typeof binding === 'string') return binding;
  return binding.get();
}

/**
 * Auth middleware that requires a valid Gastown agent JWT via
 * `Authorization: Bearer <jwt>`.
 *
 * Sets `agentJWT` on the Hono context.
 */
export const authMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
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
    console.error('[auth] GASTOWN_JWT_SECRET not configured');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyAgentJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  // Verify the rigId in the JWT matches the route param
  const rigId = c.req.param('rigId');
  if (rigId && result.payload.rigId !== rigId) {
    return c.json(resError('Token rigId does not match route'), 403);
  }

  c.set('agentJWT', result.payload);
  return next();
});

/**
 * Restricts a route to the specific agent identified by the JWT.
 * Validates the agentId route param matches the JWT agentId.
 * Must be applied after `authMiddleware`.
 */
export const agentOnlyMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const jwt = c.get('agentJWT');
  if (!jwt) {
    return c.json(resError('Authentication required'), 401);
  }

  const agentId = c.req.param('agentId');
  if (agentId && jwt.agentId !== agentId) {
    return c.json(resError('Token agentId does not match route'), 403);
  }

  return next();
});

/**
 * When the request is agent-authenticated, returns the JWT's agentId.
 */
export function getEnforcedAgentId(c: Context<GastownEnv>): string | null {
  const jwt = c.get('agentJWT') as AgentJWTPayload | null;
  return jwt?.agentId ?? null;
}
