import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { extractBearerToken } from '@kilocode/worker-utils';
import { verifyAgentJWT, verifyContainerJWT, type AgentJWTPayload } from '../util/jwt.util';
import { resError } from '../util/res.util';
import type { GastownEnv } from '../gastown.worker';

export type AuthVariables = {
  agentJWT: AgentJWTPayload;
  townId: string;
  kiloUserId: string;
  kiloIsAdmin: boolean;
  kiloApiTokenPepper: string | null;
  kiloGastownAccess: boolean;
  requestStartTime: number;
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
 * Try to authenticate with a container-scoped JWT (scope: 'container').
 * Returns an AgentJWTPayload-shaped object if successful, null otherwise.
 * Container JWTs carry { townId, userId } but not agentId/rigId — those
 * come from the route params and are trusted because the JWT proves the
 * request came from the right town's container.
 */
function tryContainerJWTAuth(
  c: Context<GastownEnv>,
  token: string,
  jwtSecret: string
): AgentJWTPayload | null {
  const result = verifyContainerJWT(token, jwtSecret);
  if (!result.success) return null;

  // Populate agentId/rigId from route params, falling back to headers
  // for routes that don't have :agentId/:rigId params (e.g. /triage/resolve,
  // /mail). The container JWT proves the request came from this town's
  // container, so we trust both the URL and the identity headers.
  return {
    agentId: c.req.param('agentId') ?? c.req.header('X-Gastown-Agent-Id') ?? '',
    rigId: c.req.param('rigId') ?? c.req.header('X-Gastown-Rig-Id') ?? '',
    townId: result.payload.townId,
    userId: result.payload.userId,
  };
}

/**
 * Auth middleware that accepts either:
 * 1. A container-scoped JWT (scope: 'container') — preferred for container→worker calls
 * 2. A legacy per-agent JWT (HS256, 8h expiry) — retained for backwards compatibility
 *
 * Sets `agentJWT` on the Hono context. Validates:
 * - townId always (cross-town guard)
 * - rigId only for legacy agent JWTs (container JWTs are town-scoped;
 *   the container is trusted to call correct rig endpoints)
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

  // Try container-scoped JWT first (scope: 'container', 8h expiry + alarm refresh)
  let payload = tryContainerJWTAuth(c, token, secret);

  // Fall back to legacy JWT verification
  if (!payload) {
    const result = verifyAgentJWT(token, secret);
    if (!result.success) {
      return c.json(resError(result.error), 401);
    }
    payload = result.payload;
  }

  // Cross-rig guard: only enforced for legacy agent JWTs where the rigId
  // is cryptographically bound to the token. Container JWTs are town-scoped
  // and don't carry a rigId — the container is trusted within its town.
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
 * For container JWTs: agentId is populated from the route param by
 * tryContainerJWTAuth, so this check is a no-op (route param == route
 * param). This is intentional — the container JWT is town-scoped, and
 * the container is trusted to call the correct agent endpoints.
 * Cross-agent attacks require compromising the container itself, which
 * is the same trust boundary the container already has (it runs all
 * agents in the town).
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
