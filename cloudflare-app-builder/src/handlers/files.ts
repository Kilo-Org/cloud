/**
 * File tree and blob endpoint handlers
 * GET /apps/{app_id}/tree/{ref} - Get directory contents
 * GET /apps/{app_id}/blob/{ref}/{path} - Get file content
 */

import { verifyBearerToken } from '../utils/auth';
import { logger } from '../utils/logger';
import type { Env } from '../types';

/**
 * Handle GET /apps/{app_id}/tree/{ref} request
 *
 * Lists directory contents at the specified path for a given ref.
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param appId - The application/repository ID
 * @param ref - Branch name (e.g., "main", "HEAD") or commit SHA
 */
export async function handleGetTree(
  request: Request,
  env: Env,
  appId: string,
  ref: string
): Promise<Response> {
  const authResult = verifyBearerToken(request, env);
  if (!authResult.isAuthenticated) {
    if (!authResult.errorResponse) {
      return new Response('Unauthorized', { status: 401 });
    }
    return authResult.errorResponse;
  }

  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '';

  const id = env.GIT_REPOSITORY.idFromName(appId);
  const stub = env.GIT_REPOSITORY.get(id);

  try {
    const result = await stub.getTree(ref, path);
    return new Response(
      JSON.stringify({
        entries: result.entries,
        path,
        ref,
        commitSha: result.commitSha,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    logger.error('Failed to get tree', {
      appId,
      ref,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: error instanceof Error ? error.message : 'Path not found',
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Handle GET /apps/{app_id}/blob/{ref}/{path} request
 *
 * Returns the content of a file at the specified path for a given ref.
 * @param request - The incoming request
 * @param env - Environment bindings
 * @param appId - The application/repository ID
 * @param ref - Branch name (e.g., "main", "HEAD") or commit SHA
 * @param path - Path to the file within the repository
 */
export async function handleGetBlob(
  request: Request,
  env: Env,
  appId: string,
  ref: string,
  path: string
): Promise<Response> {
  const authResult = verifyBearerToken(request, env);
  if (!authResult.isAuthenticated) {
    if (!authResult.errorResponse) {
      return new Response('Unauthorized', { status: 401 });
    }
    return authResult.errorResponse;
  }

  const id = env.GIT_REPOSITORY.idFromName(appId);
  const stub = env.GIT_REPOSITORY.get(id);

  try {
    const result = await stub.getBlob(ref, path);
    return new Response(
      JSON.stringify({
        content: result.content,
        encoding: result.encoding,
        size: result.size,
        path,
        sha: result.sha,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    logger.error('Failed to get blob', {
      appId,
      ref,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(
      JSON.stringify({
        error: 'not_found',
        message: error instanceof Error ? error.message : 'File not found',
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
