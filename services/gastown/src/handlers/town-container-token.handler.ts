import type { Context } from 'hono';
import { extractBearerToken } from '@kilocode/worker-utils';
import type { GastownEnv } from '../gastown.worker';
import { verifyContainerJWTAllowExpired, signContainerJWT } from '../util/jwt.util';
import { resolveSecret } from '../util/secret.util';
import { resSuccess, resError } from '../util/res.util';

/**
 * POST /api/towns/:townId/refresh-container-token
 *
 * Mint a fresh container-scoped JWT for a container whose current
 * token is near expiry or already expired. The caller authenticates
 * with its existing container token. The signature must be valid —
 * we previously issued it — but the token is allowed to be expired
 * so a container that's been asleep past the 8h TTL can still
 * bootstrap a new token before calling any other endpoints.
 *
 * This endpoint only mints a new token; it does NOT push the token
 * to the running container (the caller is the container itself;
 * there's nothing to push). The caller is expected to write the
 * token into its own `process.env.GASTOWN_CONTAINER_TOKEN` and
 * invoke the existing `/refresh-token` control-server path if it
 * needs to propagate the token to spawned kilo serve children.
 */
export async function handleRefreshContainerToken(
  c: Context<GastownEnv>,
  params: { townId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    console.error('[refresh-container-token] failed to resolve GASTOWN_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const result = verifyContainerJWTAllowExpired(token, secret);
  if (!result.success) {
    return c.json(resError(result.error), 401);
  }

  if (result.payload.townId !== params.townId) {
    return c.json(resError('Cross-town access denied'), 403);
  }

  const freshToken = signContainerJWT(
    { townId: result.payload.townId, userId: result.payload.userId },
    secret
  );
  console.log(
    `[refresh-container-token] issued fresh token for town=${params.townId} expiredInbound=${result.expired}`
  );
  return c.json(resSuccess({ token: freshToken, expiredInbound: result.expired }), 200);
}
