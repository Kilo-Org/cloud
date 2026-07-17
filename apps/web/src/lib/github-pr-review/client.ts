import 'server-only';

import { Octokit } from '@octokit/rest';

/**
 * Env seam used to point the GitHub API client at a deterministic test
 * fixture (e.g. a local mock server in E2E). When unset, calls hit the real
 * `api.github.com`. GraphQL requests are issued with `octokit.request('POST
 * /graphql', …)`, which uses Octokit's `baseUrl` to derive the GraphQL URL —
 * so the same env value covers REST and GraphQL.
 */
export const GITHUB_API_BASE_URL = process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com';

export function createGitHubPrReviewOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    baseUrl: GITHUB_API_BASE_URL,
    userAgent: 'kilo-mobile-github-pr-review',
  });
}
