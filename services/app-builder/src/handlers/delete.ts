import type { Env } from '../types';
import { verifyBearerToken } from '../utils/auth';
import { logger, formatError } from '../utils/logger';

export async function handleDelete(request: Request, env: Env, appId: string): Promise<Response> {
  // Verify server-to-server auth token
  const authResult = verifyBearerToken(request, env);
  if (!authResult.isAuthenticated) {
    if (!authResult.errorResponse) {
      return new Response('Unauthorized', { status: 401 });
    }
    return authResult.errorResponse;
  }

  logger.info('Deleting app');

  try {
    // Delete git repository data
    const gitId = env.GIT_REPOSITORY.idFromName(appId);
    const gitStub = env.GIT_REPOSITORY.get(gitId);
    await gitStub.deleteAll();

    // Delete preview data and sandbox
    const previewId = env.PREVIEW.idFromName(appId);
    const previewStub = env.PREVIEW.get(previewId);
    await previewStub.deleteAll();

    logger.info('App deleted successfully');

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    logger.error('Failed to delete app', formatError(error));
    return new Response(
      JSON.stringify({
        error: 'internal_error',
        message: error instanceof Error ? error.message : 'Failed to delete app',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
