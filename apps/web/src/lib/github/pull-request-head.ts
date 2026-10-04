/**
 * GitHub addresses a pull request head with two independent body fields. `head` is
 * `[<owner>:]<branch>`, and a bare branch name is always resolved inside the base repository.
 * `head_repo` (`owner/repo`) names the repository the branch actually lives in, and GitHub
 * requires it for a cross-repository pull whose head and base share an organization, because
 * `owner:branch` cannot disambiguate between that organization's forks of the base.
 */

export type GitHubRepositoryCoordinates = {
  owner: string;
  repo: string;
};

export type GitHubPullRequestHead = {
  branch: string;
  ref: string;
  headRepo: string | null;
  repository: GitHubRepositoryCoordinates;
};

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// `.` and `..` match the character class but URL-normalize away when interpolated into a
// request path, so they must be excluded explicitly.
const REPO_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

export function parseGitHubRepositoryCoordinates(
  fullName: string
): GitHubRepositoryCoordinates | null {
  const parts = fullName.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
}

function normalizeGitHubBranchName(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, '');
}

function isSameGitHubRepository(
  left: GitHubRepositoryCoordinates,
  right: GitHubRepositoryCoordinates
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  );
}

/**
 * `headRepo` is `null` for a same-repository pull, which is also the only case where a bare
 * branch name as `head` means what the caller intends. Any foreign head is qualified with its
 * owner and paired with `head_repo`, because either field alone is rejected or ambiguous.
 */
export function buildGitHubPullRequestHead(params: {
  headBranch: string;
  headRepository: GitHubRepositoryCoordinates;
  baseRepository: GitHubRepositoryCoordinates;
}): GitHubPullRequestHead {
  const branch = normalizeGitHubBranchName(params.headBranch);
  if (branch.length === 0) {
    throw new Error('Pull request head branch must not be empty');
  }

  if (isSameGitHubRepository(params.headRepository, params.baseRepository)) {
    return { branch, ref: branch, headRepo: null, repository: params.headRepository };
  }

  return {
    branch,
    ref: `${params.headRepository.owner}:${branch}`,
    headRepo: `${params.headRepository.owner}/${params.headRepository.repo}`,
    repository: params.headRepository,
  };
}
