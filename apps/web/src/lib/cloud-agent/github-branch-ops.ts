import 'server-only';

import { Octokit } from '@octokit/rest';

import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';

function splitRepository(repositoryFullName: string): { owner: string; repo: string } {
  const [owner, repo] = repositoryFullName.split('/');
  if (!owner || !repo) {
    throw new Error('Expected a GitHub repository as owner/repo');
  }
  return { owner, repo };
}

function isNotFound(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 404;
}

/**
 * The exact remote head of one branch through the installation that already
 * authorized the session's repository. A missing branch is `null`, not an
 * error, because "not pushed yet" is a state the caller reports.
 */
export async function fetchGitHubBranchHead(params: {
  installationId: string;
  appType: GitHubAppType;
  expectedIntegrationId: string;
  repositoryFullName: string;
  branch: string;
  purpose: 'workflow' | 'agent';
}): Promise<{ sha: string } | null> {
  const token = await generateGitHubInstallationToken(
    params.installationId,
    params.appType,
    params.expectedIntegrationId,
    params.purpose
  );
  const octokit = new Octokit({ auth: token.token });
  const { owner, repo } = splitRepository(params.repositoryFullName);
  try {
    const { data } = await octokit.repos.getBranch({
      owner,
      repo,
      branch: params.branch,
    });
    return { sha: data.commit.sha };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Idempotently point an existing pull request at another base branch. Used
 * after a completed Restack when GitHub has not already retargeted the stack.
 */
export async function retargetGitHubPullRequestBase(params: {
  installationId: string;
  expectedIntegrationId: string;
  repositoryFullName: string;
  pullNumber: number;
  base: string;
  purpose: 'workflow' | 'agent';
}): Promise<void> {
  const token = await generateGitHubInstallationToken(
    params.installationId,
    'standard',
    params.expectedIntegrationId,
    params.purpose
  );
  const octokit = new Octokit({ auth: token.token });
  const { owner, repo } = splitRepository(params.repositoryFullName);
  await octokit.pulls.update({
    owner,
    repo,
    pull_number: params.pullNumber,
    base: params.base,
  });
}
