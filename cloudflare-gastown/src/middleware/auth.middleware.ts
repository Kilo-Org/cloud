import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { verifyAgentJWT, type AgentJWTPayload } from '../util/jwt.util';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export type AuthVariables = {
  authMode: 'internal' | 'agent';
  agentJWT: AgentJWTPayload | null;
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
 * Combined auth middleware that accepts either:
 * - Internal: `X-Internal-API-Key` header matching the stored secret
 * - Agent:    `Authorization: Bearer <jwt>` with a valid Gastown agent JWT
 *
 * Sets `authMode` and (when agent) `agentJWT` on the Hono context.
 */
export const authMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  // Try internal auth first
  const apiKey = c.req.header('X-Internal-API-Key');
  if (apiKey) {
    const secret = await resolveSecret(c.env.INTERNAL_API_SECRET);
    if (!secret) {
      console.error('[auth] INTERNAL_API_SECRET not configured');
      return c.json(resError('Internal server error'), 500);
    }
    if (apiKey !== secret) {
      return c.json(resError('Unauthorized'), 401);
    }
    c.set('authMode', 'internal');
    c.set('agentJWT', null);
    return next();
  }

  // Try agent JWT auth
  const authHeader = c.req.header('Authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
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

    c.set('authMode', 'agent');
    c.set('agentJWT', result.payload);
    return next();
  }

  return c.json(resError('Authentication required'), 401);
});

/**
 * Restricts a route to agent auth only. Must be applied after `authMiddleware`.
 * Validates the agentId route param matches the JWT agentId.
 */
/**
 * When the request is agent-authenticated, returns the JWT's agentId.
 * For internal auth returns null (caller is trusted to supply any agent_id).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getEnforcedAgentId(c: Context<any>): string | null {
  if (c.get('authMode') !== 'agent') return null;
  const jwt = c.get('agentJWT') as AgentJWTPayload | null;
  return jwt?.agentId ?? null;
}

/**
 * Restricts a route to internal auth only (X-Internal-API-Key).
 * Rejects agent JWT auth. Must be applied after `authMiddleware`.
 */
export const internalOnlyMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const authMode = c.get('authMode');
  if (authMode !== 'internal') {
    return c.json(resError('Forbidden: internal auth required'), 403);
  }
  return next();
});

export const agentOnlyMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const authMode = c.get('authMode');
  if (authMode === 'internal') {
    // Internal auth is trusted to act on behalf of any agent
    return next();
  }
  if (authMode !== 'agent') {
    // authMode is unset or unexpected — authMiddleware was not applied
    return c.json(resError('Authentication required'), 401);
  }

  const jwt = c.get('agentJWT');
  const agentId = c.req.param('agentId');
  if (agentId && jwt && jwt.agentId !== agentId) {
    return c.json(resError('Token agentId does not match route'), 403);
  }

  return next();
});
