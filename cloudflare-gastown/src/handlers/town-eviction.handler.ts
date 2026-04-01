import type { Context } from 'hono';
import { extractBearerToken } from '@kilocode/worker-utils';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { verifyContainerJWT } from '../util/jwt.util';
import { resolveSecret } from '../util/secret.util';
import { resSuccess, resError } from '../util/res.util';

/**
 * POST /api/towns/:townId/container-eviction
 *
 * Called by the container's process-manager when the container receives
 * SIGTERM. Inserts a `container_eviction` event and sets the draining
 * flag so the reconciler stops dispatching new work.
 *
 * Returns a `drainNonce` that must be presented via `/container-ready`
 * to clear the drain flag. This prevents stale heartbeats from the
 * dying container from prematurely re-enabling dispatch.
 *
 * Authenticated with the container-scoped JWT (same token used for all
 * container→worker calls).
 */
export async function handleContainerEviction(
  c: Context<GastownEnv>,
  params: { townId: string }
): Promise<Response> {
  // Authenticate with container JWT
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    console.error('[town-eviction] failed to resolve GASTOWN_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  // Cross-town guard
  if (result.payload.townId !== params.townId) {
    return c.json(resError('Cross-town access denied'), 403);
  }

  const town = getTownDOStub(c.env, params.townId);
  const drainNonce = await town.recordContainerEviction();

  console.log(`[town-eviction] container eviction recorded for town=${params.townId}`);
  return c.json(resSuccess({ acknowledged: true, drainNonce }), 200);
}

/**
 * GET /api/towns/:townId/drain-status
 *
 * Lightweight endpoint for the container to poll drain state. Used by
 * the heartbeat module when no agents are running — the per-agent
 * heartbeat loop has nothing to iterate, so a separate check is needed
 * to discover the drain nonce and call /container-ready.
 *
 * Authenticated with the container-scoped JWT.
 */
export async function handleDrainStatus(
  c: Context<GastownEnv>,
  params: { townId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  if (result.payload.townId !== params.townId) {
    return c.json(resError('Cross-town access denied'), 403);
  }

  const town = getTownDOStub(c.env, params.townId);
  const [draining, drainNonce] = await Promise.all([town.isDraining(), town.getDrainNonce()]);

  return c.json(resSuccess({ draining, drainNonce }), 200);
}

/**
 * POST /api/towns/:townId/container-ready
 *
 * Called by the replacement container on startup to signal readiness.
 * Clears the draining flag only if the provided `drainNonce` matches
 * the nonce generated during the eviction that triggered the drain.
 *
 * Authenticated with the container-scoped JWT.
 */
export async function handleContainerReady(
  c: Context<GastownEnv>,
  params: { townId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    console.error('[container-ready] failed to resolve GASTOWN_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWT(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  if (result.payload.townId !== params.townId) {
    return c.json(resError('Cross-town access denied'), 403);
  }

  let nonce: string | undefined;
  try {
    const body: unknown = await c.req.json();
    if (
      body &&
      typeof body === 'object' &&
      'nonce' in body &&
      typeof (body as { nonce: unknown }).nonce === 'string'
    ) {
      nonce = (body as { nonce: string }).nonce;
    }
  } catch {
    // No body or invalid JSON
  }

  if (!nonce) {
    return c.json(resError('Missing required field: nonce'), 400);
  }

  const town = getTownDOStub(c.env, params.townId);
  const cleared = await town.acknowledgeContainerReady(nonce);

  console.log(`[container-ready] town=${params.townId} nonce=${nonce} cleared=${cleared}`);
  return c.json(resSuccess({ cleared }), 200);
}
