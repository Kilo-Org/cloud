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
  await town.recordContainerEviction();

  console.log(`[town-eviction] container eviction recorded for town=${params.townId}`);
  return c.json(resSuccess({ acknowledged: true }), 200);
}
