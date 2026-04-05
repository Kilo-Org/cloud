/**
 * Token generation endpoint handler
 * POST /apps/{app-id}/token
 *
 * Generates a short-lived JWT token for git repository access
 */

import { logger } from '../utils/logger';
import { verifyBearerToken } from '../utils/auth';
import { signGitToken, DEFAULT_EXPIRY_SECONDS, type GitTokenPermission } from '../utils/jwt';
import { TokenRequestSchema } from '../api-schemas';
import type { Env } from '../types';

/**
 * Handle POST /apps/{app-id}/token request
 * Generates a short-lived JWT token for git repository access
 */
export async function handleGenerateToken(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  const authResult = verifyBearerToken(request, env);
  if (!authResult.isAuthenticated) {
    if (!authResult.errorResponse) {
      return new Response('Unauthorized', { status: 401 });
    }
    return authResult.errorResponse;
  }

  const parseResult = TokenRequestSchema.safeParse(await request.json());
  if (!parseResult.success) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'invalid_parameter',
        message:
          parseResult.error.issues[0]?.message ??
          "Invalid 'permission' value. Must be 'full' or 'ro'",
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const permission: GitTokenPermission = parseResult.data.permission;

  const id = env.GIT_REPOSITORY.idFromName(appId);
  const stub = env.GIT_REPOSITORY.get(id);

  const isInitialized = await stub.isInitialized();
  if (!isInitialized) {
    return new Response(
      JSON.stringify({
        success: false,
        error: 'not_found',
        message: `Repository '${appId}' not initialized`,
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const parsedExpiry = env.GIT_TOKEN_EXPIRY_SECONDS
    ? parseInt(env.GIT_TOKEN_EXPIRY_SECONDS, 10)
    : NaN;
  const expirySeconds = Number.isNaN(parsedExpiry) ? DEFAULT_EXPIRY_SECONDS : parsedExpiry;

  const token = signGitToken(appId, permission, env.GIT_JWT_SECRET, expirySeconds);

  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

  logger.info('Generated git token', { permission, expirySeconds });

  return new Response(
    JSON.stringify({
      success: true,
      token,
      expires_at: expiresAt,
      permission,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
