/**
 * GitHub Pull Request Creation Helper (Auto Fix)
 *
 * Creates a pull request using the GitHub REST API.
 * Used by the auto-fix system to create PRs for bug fixes and features.
 */

import 'server-only';
import { captureException } from '@sentry/nextjs';
import {
  buildGitHubPullRequestHead,
  parseGitHubRepositoryCoordinates,
} from '@/lib/github/pull-request-head';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';

export type CreatePullRequestParams = {
  /** Repository the pull request is opened against. */
  repoFullName: string;
  /** Repository the head branch was pushed to, when it is a fork. Defaults to `repoFullName`. */
  headRepoFullName?: string;
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
    headRepoFullName: params.headRepoFullName,
    baseBranch,
    headBranch,
    titleLength: title.length,
    bodyLength: body.length,
  });

  const baseRepository = parseGitHubRepositoryCoordinates(repoFullName);
  if (!baseRepository) {
    throw new Error(`Invalid repository name format: ${repoFullName}`);
  }
  const { owner, repo } = baseRepository;

  const headRepositoryFullName = params.headRepoFullName ?? repoFullName;
  const headRepository = parseGitHubRepositoryCoordinates(headRepositoryFullName);
  if (!headRepository) {
    throw new Error(`Invalid repository name format: ${headRepositoryFullName}`);
  }

  try {
    const pullRequestHead = buildGitHubPullRequestHead({
      headBranch,
      headRepository,
      baseRepository,
    });
    const encodedBranchPath = encodeURIComponent(pullRequestHead.branch);
    const branchCheckResponse = await fetch(
      `https://api.github.com/repos/${pullRequestHead.repository.owner}/${pullRequestHead.repository.repo}/git/ref/heads/${encodedBranchPath}`,
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
        headBranch: pullRequestHead.branch,
        headRepoFullName: headRepositoryFullName,
        status: branchCheckResponse.status,
        error: branchError,
      });
      throw new Error(
        pullRequestHead.headRepo === null
          ? `Branch '${pullRequestHead.branch}' does not exist on GitHub. The branch may not have been pushed yet. Please ensure the Cloud Agent successfully pushed the branch before creating a PR.`
          : `Branch '${pullRequestHead.branch}' could not be read from ${pullRequestHead.headRepo} on GitHub (HTTP ${branchCheckResponse.status}). Either it was never pushed there, or the GitHub App is not installed on that repository.`
      );
    }

    logExceptInTest('[auto-fix:createPullRequest] Branch verified on GitHub', {
      headBranch: pullRequestHead.branch,
      headRepoFullName: headRepositoryFullName,
    });

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
        head: pullRequestHead.ref,
        base: baseBranch,
        ...(pullRequestHead.headRepo === null ? {} : { head_repo: pullRequestHead.headRepo }),
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
      extra: { repoFullName, headRepositoryFullName, baseBranch, headBranch },
    });
    throw error;
  }
}
