import type { Context } from 'hono';
import { extractBearerToken } from '@kilocode/worker-utils';
import type { GastownEnv } from '../gastown.worker';
import { getTownDOStub } from '../dos/Town.do';
import { verifyContainerJWT } from '../util/jwt.util';
import { resolveSecret } from '../util/secret.util';
import { resSuccess, resError } from '../util/res.util';
import { resolveGitHubToken } from '../dos/town/town-scm';

/**
 * POST /api/towns/:townId/rigs/:rigId/refresh-git-token
 *
 * Called by the container when a git operation fails with 401/403 —
 * i.e. the GitHub App installation token embedded in GIT_TOKEN has
 * expired (1h TTL). Resolves a fresh token via the standard chain
 * (town config → platform integration) and returns it to the caller.
 *
 * Authenticated with the container-scoped JWT (same token used for
 * all other container→worker calls).
 */
export async function handleRefreshGitToken(
  c: Context<GastownEnv>,
  params: { townId: string; rigId: string }
): Promise<Response> {
  const token = extractBearerToken(c.req.header('Authorization'));
  if (!token) {
    return c.json(resError('Authentication required'), 401);
  }

  const secret = await resolveSecret(c.env.GASTOWN_JWT_SECRET);
  if (!secret) {
    console.error('[refresh-git-token] failed to resolve GASTOWN_JWT_SECRET');
    return c.json(resError('Internal server error'), 500);
  }

  const verified = verifyContainerJWT(token, secret);
  if (!verified.success) {
    return c.json(resError(verified.error), 401);
  }

  if (verified.payload.townId !== params.townId) {
    return c.json(resError('Cross-town access denied'), 403);
  }

  const town = getTownDOStub(c.env, params.townId);
  const rigConfig = await town.getRigConfig(params.rigId);

  const freshToken = await resolveGitHubToken({
    env: c.env,
    townId: params.townId,
    getTownConfig: () => town.getTownConfig(),
    platformIntegrationId: rigConfig?.platformIntegrationId,
  });

  if (!freshToken) {
    console.warn(
      `[refresh-git-token] no token available for town=${params.townId} rig=${params.rigId}`
    );
    return c.json(resError('No git token available for this rig'), 404);
  }

  console.log(
    `[refresh-git-token] refreshed git token for town=${params.townId} rig=${params.rigId}`
  );
  return c.json(resSuccess({ token: freshToken }), 200);
}
