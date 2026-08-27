/**
 * Migrate to GitHub endpoint handler
 * POST /apps/{app-id}/migrate-to-github
 *
 * Pushes the internal repository to GitHub, then configures the preview
 * to clone from GitHub and schedules deletion of the internal git repo.
 */

import { logger, formatError } from '../utils/logger';
import { verifyBearerToken } from '../utils/auth';
import type { Env } from '../types';
import { MigrateToGithubRequestSchema } from '../api-schemas';

export async function handleMigrateToGithub(
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

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'invalid_request',
          message: 'Invalid JSON',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const result = MigrateToGithubRequestSchema.safeParse(body);
    if (!result.success) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'invalid_request',
          message: result.error.issues[0]?.message ?? 'Invalid request body',
        }),
        {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    const { githubRepo, userId, orgId, expectedPlatformIntegrationId } = result.data;

    // 1. Fetch a GitHub token via git-token-service
    const tokenResult = await env.GIT_TOKEN_SERVICE.getTokenForRepo({
      githubRepo,
      userId,
      orgId,
      expectedIntegrationId: expectedPlatformIntegrationId,
    });
    if (!tokenResult.success) {
      logger.error({ source: 'MigrateToGithubHandler', appId }, 'Failed to get GitHub token', {
        reason: tokenResult.reason,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'token_failed',
          message: `Failed to get GitHub token: ${tokenResult.reason}`,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const [repoOwner, repoName] = githubRepo.split('/');
    if (!repoOwner || !repoName) {
      return Response.json(
        {
          success: false,
          error: 'invalid_request',
          message: 'Invalid repository name',
        },
        { status: 400 }
      );
    }
    try {
      const commitsResponse = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/commits?per_page=1`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${tokenResult.token}`,
            'User-Agent': 'Kilo-App-Builder',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      if (commitsResponse.status === 404) {
        return Response.json(
          {
            success: false,
            error: 'repo_not_found',
            message: 'Repository not found',
          },
          { status: 200 }
        );
      }
      if (commitsResponse.status !== 409) {
        if (!commitsResponse.ok) {
          throw new Error(`GitHub returned ${commitsResponse.status}`);
        }
        const commits: unknown = await commitsResponse.json();
        if (!Array.isArray(commits)) {
          throw new Error('GitHub returned an invalid commits response');
        }
        if (commits.length > 0) {
          return Response.json(
            {
              success: false,
              error: 'repo_not_empty',
              message: 'Repository is not empty',
            },
            { status: 200 }
          );
        }
      }
    } catch (error) {
      logger.error(
        { source: 'MigrateToGithubHandler', appId },
        'Failed to validate GitHub repository',
        formatError(error)
      );
      return Response.json(
        {
          success: false,
          error: 'internal_error',
          message: 'Failed to validate GitHub repository',
        },
        { status: 200 }
      );
    }

    const remoteUrl = new URL(`https://github.com/${githubRepo}.git`);
    remoteUrl.username = 'x-access-token';
    remoteUrl.password = tokenResult.token;

    // 2. Push internal git repo to GitHub
    const gitId = env.GIT_REPOSITORY.idFromName(appId);
    const gitStub = env.GIT_REPOSITORY.get(gitId);

    const isInitialized = await gitStub.isInitialized();
    if (!isInitialized) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'internal_error',
          message: 'Repository not found',
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    logger.info({ source: 'MigrateToGithubHandler', appId }, 'Pushing repository to remote', {
      githubRepo,
    });

    const pushResult = await gitStub.pushToRemote(remoteUrl.toString(), tokenResult.token);
    if (!pushResult.success) {
      logger.error({ source: 'MigrateToGithubHandler', appId }, 'Failed to push to remote', {
        error: pushResult.error,
      });
      return new Response(
        JSON.stringify({
          success: false,
          error: 'push_failed',
          message: pushResult.error || 'Failed to push to remote',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Switch preview to GitHub source and schedule internal repo deletion
    logger.info({ source: 'MigrateToGithubHandler', appId }, 'Migrating preview to GitHub', {
      githubRepo,
      hasOrgId: !!orgId,
    });

    const previewId = env.PREVIEW.idFromName(appId);
    const previewStub = env.PREVIEW.get(previewId);

    await previewStub.setGitHubSource({
      githubRepo,
      userId,
      orgId,
      platformIntegrationId: tokenResult.platformIntegrationId,
    });

    // Schedule internal git repo deletion after a 7-day grace period (for rollback safety)
    await gitStub.scheduleDelete(7 * 24 * 60 * 60 * 1000);

    logger.info({ source: 'MigrateToGithubHandler', appId }, 'Successfully migrated to GitHub');

    return new Response(
      JSON.stringify({
        success: true,
        platformIntegrationId: tokenResult.platformIntegrationId,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    logger.error(
      { source: 'MigrateToGithubHandler' },
      'Migrate to GitHub handler error',
      formatError(error)
    );
    return new Response(
      JSON.stringify({
        success: false,
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
