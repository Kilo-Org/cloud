/**
 * Test worker that calls the git-token-service via RPC service binding.
 *
 * This worker connects to the git-token-service-dev worker using a service
 * binding, allowing you to test the full RPC flow over the binding.
 *
 * Usage:
 *   1. Start the git-token-service: pnpm dev (in cloudflare-git-token-service)
 *   2. Start this test worker: pnpm dev:test
 *
 * Endpoints:
 *   POST /getTokenForRepo - { githubRepo, userId, orgId? }
 *   POST /getToken - { installationId, appType? }
 */
import type {
  GitTokenRPCEntrypoint,
  GetTokenForRepoParams,
  GetTokenForRepoResult,
} from '../src/index.js';
import type { GitHubAppType } from '../src/github-token-service.js';

type Env = {
  GIT_TOKEN_SERVICE: Service<GitTokenRPCEntrypoint>;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/getTokenForRepo' && request.method === 'POST') {
        const body = (await request.json()) as GetTokenForRepoParams;
        const result: GetTokenForRepoResult = await env.GIT_TOKEN_SERVICE.getTokenForRepo(body);
        if (!result.success) {
          return Response.json(result, { status: 404 });
        }
        return Response.json(result);
      }

      if (url.pathname === '/getToken' && request.method === 'POST') {
        const { installationId, appType } = (await request.json()) as {
          installationId: string;
          appType?: GitHubAppType;
        };
        const token: string = await env.GIT_TOKEN_SERVICE.getToken(installationId, appType);
        return Response.json({ success: true, data: { token } });
      }

      return Response.json(
        {
          error: 'Not Found',
          endpoints: [
            'POST /getTokenForRepo - { githubRepo, userId, orgId? }',
            'POST /getToken - { installationId, appType? }',
          ],
        },
        { status: 404 }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return Response.json({ success: false, error: message }, { status: 500 });
    }
  },
};
