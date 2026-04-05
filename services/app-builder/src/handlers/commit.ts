/**
 * Commit endpoint handler
 * GET /apps/{app-id}/commit
 *
 * Returns the current commit hash for a project.
 */

import { logger, formatError } from '../utils/logger';
import { verifyBearerToken } from '../utils/auth';
import type { Env } from '../types';

/**
 * Handle GET /apps/{app-id}/commit request
 *
 * Returns the latest commit hash for the repository.
 */
export async function handleGetCommit(
  request: Request,
  env: Env,
  appId: string
): Promise<Response> {
  try {
    const authResult = verifyBearerToken(request, env);
    if (!authResult.isAuthenticated) {
      if (!authResult.errorResponse) {
        return new Response('Unauthorized', { status: 401 });
      }
      return authResult.errorResponse;
    }

    const id = env.GIT_REPOSITORY.idFromName(appId);
    const stub = env.GIT_REPOSITORY.get(id);

    const isInitialized = await stub.isInitialized();

    if (!isInitialized) {
      return new Response(
        JSON.stringify({
          error: 'not_found',
          message: `Repository '${appId}' not found`,
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const commitHash = await stub.getLatestCommit();

    if (!commitHash) {
      return new Response(
        JSON.stringify({
          error: 'no_commits',
          message: 'Repository has no commits',
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    return new Response(
      JSON.stringify({
        commit: commitHash,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    logger.error('Commit handler error', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
