import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyAgentJWT, type AgentJWTPayload } from '../util/jwt.util';
import { verifyContainerSecret } from '../util/container-secret.util';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export type AuthVariables = {
  agentJWT: AgentJWTPayload;
  townId: string;
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloGastownAccess: boolean;
};

import { resolveSecret } from '../util/secret.util';

/**
 * Extracts `townId` from the route param `:townId` and sets it on the Hono
 * context. Returns 400 if the param is missing.
 *
 * Must run unconditionally (even in dev) so handlers can always call
 * `c.get('townId')`. Does NOT check JWT — cross-town validation is handled
 * by `authMiddleware` which runs after this in production.
 */
export const townIdMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const townId = c.req.param('townId');
  if (!townId) {
    return c.json(resError('Missing townId'), 400);
  }
  c.set('townId', townId);
  return next();
});

/**
 * Try to authenticate with a container secret (HMAC-based, no expiry).
 * Returns the AgentJWTPayload-shaped object if successful, null otherwise.
 * Agent identity comes from X-Gastown-* headers which are trusted because
 * the container secret proves the request came from the right town's container.
 */
async function tryContainerSecretAuth(
  c: Context<GastownEnv>,
  token: string,
  jwtSecret: string
): Promise<AgentJWTPayload | null> {
  // Container secrets contain colons (format: townId:nonce:hmac).
  // JWTs contain dots (format: header.payload.signature).
  // Quick format check to avoid unnecessary HMAC computation on JWTs.
  if (!token.includes(':') || token.includes('.')) return null;

  const result = await verifyContainerSecret(token, jwtSecret);
  if (!result.success) return null;

  // Build an AgentJWTPayload from the container secret + headers.
  // The container secret proves town membership; headers provide agent identity.
  const agentId = c.req.header('X-Gastown-Agent-Id') ?? '';
  const rigId = c.req.header('X-Gastown-Rig-Id') ?? '';
  const userId = c.req.header('X-Gastown-User-Id') ?? '';

  return {
    agentId,
    rigId,
    townId: result.payload.townId,
    userId,
  };
}

/**
 * Auth middleware that accepts either:
 * 1. A container secret (HMAC-based, no expiry) — preferred for container→worker calls
 * 2. A legacy agent JWT (HS256, 8h expiry) — retained for backwards compatibility
 *
 * Sets `agentJWT` on the Hono context. Also validates the token's townId
 * and rigId match the route params to prevent cross-town/cross-rig access.
 */
export const authMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    console.error('[auth] failed to resolve GASTOWN_JWT_SECRET from Secrets Store');
    return c.json(resError('Internal server error'), 500);
  }

  // Try container secret first (fast HMAC check, no expiry)
  let payload = await tryContainerSecretAuth(c, token, secret);

  // Fall back to legacy JWT verification
  if (!payload) {
    const result = verifyAgentJWT(token, secret);
    if (!result.success) {
      return c.json(resError(result.error), 401);
    }
    payload = result.payload;
  }

  // Verify the rigId matches the route param
  const rigId = c.req.param('rigId');
  if (rigId && payload.rigId && payload.rigId !== rigId) {
    return c.json(resError('Token rigId does not match route'), 403);
  }

  // Verify the townId matches the route param (cross-town guard)
  const townId = c.req.param('townId');
  if (townId && townId !== payload.townId) {
    return c.json(resError('Cross-town access denied'), 403);
  }

  c.set('agentJWT', payload);
  return next();
});

/**
 * Restricts a route to the specific agent identified by the auth token.
 * Validates the agentId route param matches the token's agentId.
 * Must be applied after `authMiddleware`.
 *
 * When using container secrets, agent identity is provided via headers
 * and is not cryptographically bound to the token. The container secret
 * proves the request came from the right town's container, and the
 * container itself is trusted to correctly identify its agents.
 */
export const agentOnlyMiddleware = createMiddleware<GastownEnv>(async (c, next) => {
  const jwt = c.get('agentJWT');
  if (!jwt) {
    return c.json(resError('Authentication required'), 401);
  }

  const agentId = c.req.param('agentId');
  if (agentId && jwt.agentId && jwt.agentId !== agentId) {
    return c.json(resError('Token agentId does not match route'), 403);
  }

  return next();
});

/**
 * When the request is agent-authenticated, returns the JWT's agentId.
 */
export function getEnforcedAgentId(c: Context<GastownEnv>): string | null {
  const jwt = c.get('agentJWT');
  if (!jwt) return null;
  return jwt.agentId;
}
