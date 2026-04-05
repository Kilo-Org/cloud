/**
 * GitHub Pull Request Creation Helper (Auto Fix)
 *
 * Creates a pull request using the GitHub REST API.
 * Used by the auto-fix system to create PRs for bug fixes and features.
 */

import 'server-only';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';

export type CreatePullRequestParams = {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  githubToken: string;
};

export type CreatePullRequestResult = {
  number: number;
  url: string;
};

/**
 * Create a pull request on GitHub
 *
 * @param params - Pull request parameters
 * @returns PR number and URL
 * @throws Error if PR creation fails
 */
export async function createPullRequest(
  params: CreatePullRequestParams
): Promise<CreatePullRequestResult> {
  const { repoFullName, baseBranch, headBranch, title, body, githubToken } = params;

  logExceptInTest('[auto-fix:createPullRequest] Creating PR', {
    repoFullName,
    baseBranch,
    headBranch,
    titleLength: title.length,
    bodyLength: body.length,
  });

  // Parse repo owner and name
  const [owner, repo] = repoFullName.split('/');

  if (!owner || !repo) {
    throw new Error(`Invalid repository name format: ${repoFullName}`);
  }

  try {
    // Verify the branch exists on GitHub before creating PR
    // The headBranch might be "session/xxx" which needs to be URL-encoded for the API
    const branchPath = headBranch.replace(/^refs\/heads\//, '');
    const encodedBranchPath = encodeURIComponent(branchPath);
    const branchCheckResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${encodedBranchPath}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Kilo-Auto-Fix',
        },
      }
    );

    if (!branchCheckResponse.ok) {
      const branchError = await branchCheckResponse.text();
      errorExceptInTest('[auto-fix:createPullRequest] Branch does not exist on GitHub', {
        headBranch,
        status: branchCheckResponse.status,
        error: branchError,
      });
      throw new Error(
        `Branch '${headBranch}' does not exist on GitHub. The branch may not have been pushed yet. Please ensure the Cloud Agent successfully pushed the branch before creating a PR.`
      );
    }

    logExceptInTest('[auto-fix:createPullRequest] Branch verified on GitHub', { headBranch });

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Kilo-Auto-Fix',
      },
      body: JSON.stringify({
        title,
        body,
        head: headBranch,
        base: baseBranch,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      errorExceptInTest('[auto-fix:createPullRequest] GitHub API error', {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });

      throw new Error(
        `Failed to create PR (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    const pr = (await response.json()) as {
      number: number;
      html_url: string;
    };

    logExceptInTest('[auto-fix:createPullRequest] PR created successfully', {
      prNumber: pr.number,
      prUrl: pr.html_url,
    });

    return {
      number: pr.number,
      url: pr.html_url,
    };
  } catch (error) {
    errorExceptInTest('[auto-fix:createPullRequest] Error creating PR:', error);
    captureException(error, {
      tags: { operation: 'auto-fix-create-pull-request' },
      extra: { repoFullName, baseBranch, headBranch },
    });
    throw error;
  }
}
