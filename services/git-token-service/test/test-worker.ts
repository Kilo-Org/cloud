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
 *   POST /getGitLabToken - { userId, orgId?, repositoryUrl?, createdOnPlatform? }
 *   POST /issueGitHubSessionCapability
 *   POST /redeemGitHubSessionCapability
 *   POST /issueGitLabSessionCapability
 *   POST /redeemGitLabSessionCapability
 */
import type {
  GitTokenRPCEntrypoint,
  GetTokenForRepoParams,
  GetTokenForRepoResult,
  GetGitLabTokenParams,
  GetGitLabTokenResult,
  IssueGitHubSessionCapabilityParams,
  IssueGitHubSessionCapabilityResult,
  RedeemGitHubSessionCapabilityParams,
  RedeemGitHubSessionCapabilityResult,
  IssueGitLabSessionCapabilityParams,
  IssueGitLabSessionCapabilityResult,
  RedeemGitLabSessionCapabilityParams,
  RedeemGitLabSessionCapabilityResult,
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

      if (url.pathname === '/getGitLabToken' && request.method === 'POST') {
        const body = (await request.json()) as GetGitLabTokenParams;
        const result: GetGitLabTokenResult = await env.GIT_TOKEN_SERVICE.getGitLabToken(body);
        if (!result.success) {
          return Response.json(result, { status: 404 });
        }
        return Response.json(result);
      }

      if (url.pathname === '/issueGitHubSessionCapability' && request.method === 'POST') {
        const body = (await request.json()) as IssueGitHubSessionCapabilityParams;
        const result: IssueGitHubSessionCapabilityResult =
          await env.GIT_TOKEN_SERVICE.issueGitHubSessionCapability(body);
        return Response.json(result, { status: result.success ? 200 : 400 });
      }

      if (url.pathname === '/redeemGitHubSessionCapability' && request.method === 'POST') {
        const body = (await request.json()) as RedeemGitHubSessionCapabilityParams;
        const result: RedeemGitHubSessionCapabilityResult =
          await env.GIT_TOKEN_SERVICE.redeemGitHubSessionCapability(body);
        return Response.json(result, { status: result.success ? 200 : 400 });
      }

      if (url.pathname === '/issueGitLabSessionCapability' && request.method === 'POST') {
        const body = (await request.json()) as IssueGitLabSessionCapabilityParams;
        const result: IssueGitLabSessionCapabilityResult =
          await env.GIT_TOKEN_SERVICE.issueGitLabSessionCapability(body);
        return Response.json(result, { status: result.success ? 200 : 400 });
      }

      if (url.pathname === '/redeemGitLabSessionCapability' && request.method === 'POST') {
        const body = (await request.json()) as RedeemGitLabSessionCapabilityParams;
        const result: RedeemGitLabSessionCapabilityResult =
          await env.GIT_TOKEN_SERVICE.redeemGitLabSessionCapability(body);
        return Response.json(result, { status: result.success ? 200 : 400 });
      }

      return Response.json(
        {
          error: 'Not Found',
          endpoints: [
            'POST /getTokenForRepo - { githubRepo, userId, orgId? }',
            'POST /getToken - { installationId, appType? }',
            'POST /getGitLabToken - { userId, orgId?, repositoryUrl?, createdOnPlatform? }',
            'POST /issueGitHubSessionCapability',
            'POST /redeemGitHubSessionCapability',
            'POST /issueGitLabSessionCapability',
            'POST /redeemGitLabSessionCapability',
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
